const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STATE
// ============================================================
const waitingUsers = [];       // { socketId, gender, wantGender, country, vip }
const activePairs = new Map(); // socketId -> partnerSocketId
const bannedIPs = new Set();
const userInfo = new Map();    // socketId -> full user info
const adminSockets = new Set();
const vipTokens = new Map();   // token -> { expiresAt, plan }

const ADMIN_PASSWORD = 'admin1234'; // SCHIMBĂ!

// VIP Plans
const VIP_PLANS = {
  monthly: { price: 9.99, days: 30, label: 'Monthly' },
  yearly:  { price: 59.99, days: 365, label: 'Yearly' }
};

// ============================================================
// STRIPE PAYMENT ENDPOINTS
// ============================================================

// Create Stripe Checkout Session
app.post('/api/create-checkout', async (req, res) => {
  const { userId, email, plan = 'monthly' } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const prices = {
    monthly: { amount: 999, interval: 'month' },
    yearly:  { amount: 5999, interval: 'year' }
  };
  const p = prices[plan] || prices.monthly;
  const host = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: p.amount,
          product_data: {
            name: `Nexus VIP — ${plan === 'yearly' ? 'Annual' : 'Monthly'}`,
            description: 'Gender filter · Country filter · Priority queue · VIP badge',
            images: []
          }
        },
        quantity: 1
      }],
      metadata: { userId, plan },
      success_url: `${host}/?vip_success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${host}/?vip_cancel=1`
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify payment after redirect
app.get('/api/verify-payment', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      const code = 'VIP-' + session.metadata.userId.substr(0,4).toUpperCase() +
                   '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      res.json({
        paid: true,
        userId: session.metadata.userId,
        plan: session.metadata.plan,
        code
      });
    } else {
      res.json({ paid: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe Webhook (pentru confirmare server-side)
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.json({ received: true });
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('✅ Payment confirmed for userId:', session.metadata?.userId);
    }
    res.json({ received: true });
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ============================================================
// VIP TOKEN API (in productie conectezi Stripe/PayPal aici)
// ============================================================
app.post('/api/generate-vip', (req, res) => {
  // Endpoint folosit de admin ca sa genereze tokeni VIP manual pentru test
  const { adminPass, plan } = req.body;
  if (adminPass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!VIP_PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + VIP_PLANS[plan].days * 24 * 60 * 60 * 1000;
  vipTokens.set(token, { expiresAt, plan, usedBy: null });
  res.json({ token, plan, expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/api/redeem-vip', (req, res) => {
  const { token } = req.body;
  const vip = vipTokens.get(token);
  if (!vip) return res.status(404).json({ error: 'Invalid token' });
  if (vip.usedBy) return res.status(400).json({ error: 'Token already used' });
  if (Date.now() > vip.expiresAt) return res.status(400).json({ error: 'Token expired' });
  res.json({ success: true, plan: vip.plan, expiresAt: vip.expiresAt });
});

app.get('/api/stats', (req, res) => {
  res.json({
    online: io.sockets.sockets.size,
    waiting: waitingUsers.length,
    active: Math.floor(activePairs.size / 2)
  });
});

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  if (bannedIPs.has(ip)) {
    socket.emit('banned', { reason: 'You have been banned.' });
    socket.disconnect();
    return;
  }

  userInfo.set(socket.id, {
    ip, connectedAt: Date.now(), reports: 0,
    gender: null, wantGender: 'any', country: null, vip: false, vipPlan: null
  });

  broadcastAdminStats();

  // === ADMIN ===
  socket.on('admin-login', (password) => {
    if (password === ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin-auth', { success: true });
      broadcastAdminStats();
      socket.emit('admin-users', getAdminUserList());
      socket.emit('admin-vip-tokens', getVipTokenList());
    } else {
      socket.emit('admin-auth', { success: false });
    }
  });

  socket.on('admin-generate-vip', ({ plan }) => {
    if (!adminSockets.has(socket.id)) return;
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + VIP_PLANS[plan].days * 24 * 60 * 60 * 1000;
    vipTokens.set(token, { expiresAt, plan, usedBy: null });
    io.to([...adminSockets]).emit('admin-vip-tokens', getVipTokenList());
    socket.emit('admin-vip-generated', { token, plan });
  });

  // === REDEEM VIP ===
  socket.on('redeem-vip', (token) => {
    const vip = vipTokens.get(token);
    if (!vip || vip.usedBy || Date.now() > vip.expiresAt) {
      socket.emit('vip-redeem-result', { success: false, error: 'Invalid or expired token' });
      return;
    }
    vip.usedBy = socket.id;
    vipTokens.set(token, vip);
    const info = userInfo.get(socket.id);
    info.vip = true;
    info.vipPlan = vip.plan;
    userInfo.set(socket.id, info);
    socket.emit('vip-redeem-result', { success: true, plan: vip.plan });
  });

  // === SET USER PROFILE ===
  socket.on('set-profile', ({ gender, wantGender, country }) => {
    const info = userInfo.get(socket.id);
    if (gender) info.gender = gender;
    if (wantGender) info.wantGender = wantGender;
    if (country !== undefined) info.country = country;
    userInfo.set(socket.id, info);
  });

  // === FIND PARTNER ===
  socket.on('find-partner', ({ wantGender, country } = {}) => {
    const myInfo = userInfo.get(socket.id);
    if (!myInfo) return;

    // Scoate din queue dacă era deja acolo
    const existingIdx = waitingUsers.findIndex(u => u.socketId === socket.id);
    if (existingIdx !== -1) waitingUsers.splice(existingIdx, 1);

    // Dacă era deja în pereche activă, deconectează partenerul
    disconnectPartner(socket.id);

    // Update prefs
    if (wantGender) myInfo.wantGender = wantGender;
    if (country !== undefined) myInfo.country = country;
    userInfo.set(socket.id, myInfo);

    // Curăță utilizatorii disconnectați din queue înainte de matching
    for (let i = waitingUsers.length - 1; i >= 0; i--) {
      const u = waitingUsers[i];
      if (!io.sockets.sockets.has(u.socketId)) {
        waitingUsers.splice(i, 1);
      }
    }

    // === SMART MATCHING ===
    // Pas 1: încearcă match cu aceeași țară (dacă e selectată) + gender
    // Pas 2: fallback la orice țară + gender (nu se repetă oameni recent văzuți)

    const recentlySeen = myInfo.recentlySeen || new Set();
    let partnerIdx = -1;
    let fallbackIdx = -1;

    for (let i = 0; i < waitingUsers.length; i++) {
      const candidate = waitingUsers[i];
      if (candidate.socketId === socket.id) continue;
      if (!io.sockets.sockets.has(candidate.socketId)) continue;

      const candidateInfo = userInfo.get(candidate.socketId);
      if (!candidateInfo) continue;

      // Gender matching
      const myWant = myInfo.wantGender || 'any';
      const theirWant = candidateInfo.wantGender || 'any';
      const myGender = myInfo.gender || 'any';
      const theirGender = candidateInfo.gender || 'any';
      const iWantThem = myWant === 'any' || myWant === theirGender;
      const theyWantMe = theirWant === 'any' || theirWant === myGender;
      if (!iWantThem || !theyWantMe) continue;

      // VIP gender filter strict (doar VIP poate filtra gender)
      if (myInfo.vip && myInfo.wantGender !== 'any') {
        if (myInfo.wantGender !== theirGender && theirGender !== 'any') continue;
      }

      const isRecentlySeen = recentlySeen.has(candidate.socketId);
      const sameCountry = myInfo.country && candidateInfo.country &&
                          myInfo.country === candidateInfo.country;

      // Prioritate 1: aceeași țară + nevăzut recent
      if (sameCountry && !isRecentlySeen && partnerIdx === -1) {
        partnerIdx = i;
        break; // match perfect, stop
      }

      // Prioritate 2: fallback — orice țară, dar nu recent văzut
      if (!isRecentlySeen && fallbackIdx === -1) {
        fallbackIdx = i;
        // nu break — continuăm să căutăm match perfect cu aceeași țară
      }
    }

    // Dacă nu găsim match perfect cu țara, folosim fallback
    if (partnerIdx === -1 && fallbackIdx !== -1) {
      partnerIdx = fallbackIdx;
    }

    if (partnerIdx !== -1) {
      const partner = waitingUsers[partnerIdx];
      waitingUsers.splice(partnerIdx, 1);

      activePairs.set(socket.id, partner.socketId);
      activePairs.set(partner.socketId, socket.id);

      // Salvează în recently seen (max 10 persoane)
      const myRecent = myInfo.recentlySeen || new Set();
      myRecent.add(partner.socketId);
      if (myRecent.size > 10) myRecent.delete(myRecent.values().next().value);
      myInfo.recentlySeen = myRecent;
      userInfo.set(socket.id, myInfo);

      const partnerInfo = userInfo.get(partner.socketId);
      const pRecent = partnerInfo.recentlySeen || new Set();
      pRecent.add(socket.id);
      if (pRecent.size > 10) pRecent.delete(pRecent.values().next().value);
      partnerInfo.recentlySeen = pRecent;
      userInfo.set(partner.socketId, partnerInfo);

      socket.emit('partner-found', {
        initiator: true,
        partnerGender: partnerInfo?.gender || null,
        partnerCountry: partnerInfo?.country || null,
        partnerVip: partnerInfo?.vip || false
      });
      io.to(partner.socketId).emit('partner-found', {
        initiator: false,
        partnerGender: myInfo.gender || null,
        partnerCountry: myInfo.country || null,
        partnerVip: myInfo.vip || false
      });

      broadcastAdminStats();
    } else {
      // Adaugă în queue
      if (!waitingUsers.find(u => u.socketId === socket.id)) {
        waitingUsers.push({
          socketId: socket.id,
          gender: myInfo.gender,
          wantGender: myInfo.wantGender,
          country: myInfo.country,
          vip: myInfo.vip,
          joinedAt: Date.now()
        });
      }
      socket.emit('waiting', { queueSize: waitingUsers.length });
    }
  });

  // === WEBRTC SIGNALING ===
  socket.on('signal', (data) => {
    const partner = activePairs.get(socket.id);
    if (partner) io.to(partner).emit('signal', data);
  });

  // === CHAT ===
  socket.on('chat-message', (msg) => {
    const partner = activePairs.get(socket.id);
    if (partner && msg && msg.length < 500) {
      io.to(partner).emit('chat-message', { text: msg });
    }
  });

  // === NEXT ===
  socket.on('next', () => disconnectPartner(socket.id));

  // === REPORT ===
  socket.on('report', () => {
    const partner = activePairs.get(socket.id);
    if (partner) {
      const info = userInfo.get(partner);
      if (info) {
        info.reports++;
        io.to([...adminSockets]).emit('admin-report', {
          socketId: partner, ip: info.ip, reports: info.reports
        });
      }
    }
  });

  // === ADMIN ACTIONS ===
  socket.on('admin-ban', (targetId) => {
    if (!adminSockets.has(socket.id)) return;
    const info = userInfo.get(targetId);
    if (info) {
      bannedIPs.add(info.ip);
      io.to(targetId).emit('banned', { reason: 'Banned by moderator.' });
      io.sockets.sockets.get(targetId)?.disconnect();
    }
  });

  socket.on('admin-kick', (targetId) => {
    if (!adminSockets.has(socket.id)) return;
    disconnectPartner(targetId);
    io.to(targetId).emit('kicked');
    io.sockets.sockets.get(targetId)?.disconnect();
  });

  // === ADMIN VIEW STREAM (WebRTC relay) ===
  socket.on('admin-view-stream', ({targetSid, data}) => {
    if (!adminSockets.has(socket.id)) return;
    // Forward offer/candidate to target user
    io.to(targetSid).emit('admin-requesting-stream', {
      adminSid: socket.id,
      data
    });
  });

  // Target user responds back to admin
  socket.on('admin-stream-response', ({adminSid, data}) => {
    io.to(adminSid).emit('admin-view-stream-signal', {
      fromSid: socket.id,
      data
    });
  });

  // === DISCONNECT ===
  socket.on('disconnect', () => {
    disconnectPartner(socket.id);
    const idx = waitingUsers.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);
    userInfo.delete(socket.id);
    adminSockets.delete(socket.id);
    broadcastAdminStats();
  });
});

function disconnectPartner(socketId) {
  const partner = activePairs.get(socketId);
  if (partner) {
    io.to(partner).emit('partner-left');
    activePairs.delete(partner);
  }
  activePairs.delete(socketId);
  broadcastAdminStats();
}

function broadcastAdminStats() {
  const stats = {
    online: io.sockets.sockets.size,
    waiting: waitingUsers.length,
    active: Math.floor(activePairs.size / 2),
    banned: bannedIPs.size,
    vipUsers: [...userInfo.values()].filter(u => u.vip).length
  };
  io.to([...adminSockets]).emit('admin-stats', stats);
}

function getAdminUserList() {
  return [...userInfo.entries()].map(([id, info]) => ({
    socketId: id, ip: info.ip, connectedAt: info.connectedAt,
    reports: info.reports, gender: info.gender, country: info.country,
    vip: info.vip, inPair: activePairs.has(id),
    waiting: waitingUsers.some(u => u.socketId === id)
  }));
}

function getVipTokenList() {
  return [...vipTokens.entries()].map(([token, data]) => ({
    token, plan: data.plan,
    expiresAt: new Date(data.expiresAt).toISOString(),
    used: !!data.usedBy
  }));
}

// ============================================================
// QUEUE CLEANUP — curăță utilizatorii disconnectați din queue
// ============================================================
setInterval(() => {
  const before = waitingUsers.length;
  for (let i = waitingUsers.length - 1; i >= 0; i--) {
    if (!io.sockets.sockets.has(waitingUsers[i].socketId)) {
      waitingUsers.splice(i, 1);
    }
  }
  if (waitingUsers.length !== before) {
    broadcastAdminStats();
  }
}, 5000); // la fiecare 5 secunde

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`🛡️  Admin: http://localhost:${PORT}/admin.html`);
});
