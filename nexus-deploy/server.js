const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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

    // Update prefs
    if (wantGender) myInfo.wantGender = wantGender;
    if (country !== undefined) myInfo.country = country;
    userInfo.set(socket.id, myInfo);

    // Find matching partner
    let partnerIdx = -1;

    for (let i = 0; i < waitingUsers.length; i++) {
      const candidate = waitingUsers[i];
      if (candidate.socketId === socket.id) continue;

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

      // VIP country filter
      if (myInfo.vip && myInfo.country && candidateInfo.country && myInfo.country !== candidateInfo.country) continue;
      if (candidateInfo.vip && candidateInfo.country && myInfo.country && candidateInfo.country !== myInfo.country) continue;

      partnerIdx = i;
      break;
    }

    if (partnerIdx !== -1) {
      const partner = waitingUsers[partnerIdx];
      waitingUsers.splice(partnerIdx, 1);

      activePairs.set(socket.id, partner.socketId);
      activePairs.set(partner.socketId, socket.id);

      const partnerInfo = userInfo.get(partner.socketId);

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
      if (!waitingUsers.find(u => u.socketId === socket.id)) {
        waitingUsers.push({
          socketId: socket.id,
          gender: myInfo.gender,
          wantGender: myInfo.wantGender,
          country: myInfo.country,
          vip: myInfo.vip
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`🛡️  Admin: http://localhost:${PORT}/admin.html`);
});
