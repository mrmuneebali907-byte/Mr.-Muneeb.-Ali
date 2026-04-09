/**
 * Panel Server - Web interface for managing WhatsApp bot sessions
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sessionManager = require('./sessionManager');
const { SESSION_STATUS } = require('./sessionManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1);

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: sessionManager.getSessions(), max: sessionManager.MAX_SESSIONS });
});

app.post('/api/sessions', (req, res) => {
  try {
    const { name, ownerNumber } = req.body;
    const session = sessionManager.createSession(name, ownerNumber);
    res.json({ success: true, session: { id: session.id, name: session.name } });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await sessionManager.deleteSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/start', async (req, res) => {
  try {
    await sessionManager.startSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  try {
    await sessionManager.stopSession(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/paircode', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });
    // requestPairCode handles its own fresh socket — do NOT call startSession first
    const code = await sessionManager.requestPairCode(parseInt(req.params.id), phone);
    res.json({ success: true, code });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/sessions/:id/qr', (req, res) => {
  const session = sessionManager.getSession(parseInt(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.qrImage) {
    res.json({ qr: session.qrImage, status: session.status });
  } else {
    res.json({ qr: null, status: session.status });
  }
});

app.get('/api/status', (req, res) => {
  const sessions = sessionManager.getSessions();
  const connected = sessions.filter(s => s.status === SESSION_STATUS.CONNECTED).length;
  res.json({
    total: sessions.length,
    connected,
    max: sessionManager.MAX_SESSIONS,
    uptime: process.uptime()
  });
});

// Serve panel for all other routes (wildcard fallback)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.IO real-time events ────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.emit('sessions:list', {
    sessions: sessionManager.getSessions(),
    max: sessionManager.MAX_SESSIONS
  });

  socket.on('session:start', async ({ id }) => {
    try {
      await sessionManager.startSession(id);
      socket.emit('session:ok', { id, action: 'start' });
    } catch (e) {
      socket.emit('session:error', { id, error: e.message });
    }
  });

  socket.on('session:stop', async ({ id }) => {
    try {
      await sessionManager.stopSession(id);
      socket.emit('session:ok', { id, action: 'stop' });
    } catch (e) {
      socket.emit('session:error', { id, error: e.message });
    }
  });

  socket.on('session:create', async ({ name, ownerNumber }) => {
    try {
      const session = sessionManager.createSession(name, ownerNumber);
      socket.emit('session:created', { id: session.id, name: session.name });
      io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
    } catch (e) {
      socket.emit('session:error', { error: e.message });
    }
  });

  socket.on('session:delete', async ({ id }) => {
    try {
      await sessionManager.deleteSession(id);
      io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
    } catch (e) {
      socket.emit('session:error', { id, error: e.message });
    }
  });

  socket.on('session:paircode', async ({ id, phone }) => {
    try {
      await sessionManager.startSession(id);
      const code = await sessionManager.requestPairCode(id, phone);
      socket.emit('session:paircode:result', { id, code });
    } catch (e) {
      socket.emit('session:error', { id, error: e.message });
    }
  });
});

// ── Forward session events to all connected clients ───────────────────────────

sessionManager.on('session:status', (data) => {
  io.emit('session:status', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:qr', (data) => {
  io.emit('session:qr', data);
});

sessionManager.on('session:paircode', (data) => {
  io.emit('session:paircode', data);
});

sessionManager.on('session:connected', (data) => {
  io.emit('session:connected', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:disconnected', (data) => {
  io.emit('session:disconnected', data);
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:created', (data) => {
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:deleted', (data) => {
  io.emit('sessions:refresh', { sessions: sessionManager.getSessions() });
});

sessionManager.on('session:error', (data) => {
  io.emit('session:error', data);
});

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;

function startPanelServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 Panel running at http://0.0.0.0:${PORT}`);
    console.log(`📊 Managing up to ${sessionManager.MAX_SESSIONS} bot sessions\n`);
    sessionManager.autoStartSessions();
  });
}

module.exports = { startPanelServer, app, io };
