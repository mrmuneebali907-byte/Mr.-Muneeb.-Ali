/**
 * Session Manager — manages up to 50 independent WhatsApp bot sessions.
 *
 * Stability improvements:
 *  • Unlimited auto-reconnect (exponential back-off, caps at 2 min)
 *  • Cached Baileys version (no HTTP call on every reconnect)
 *  • Per-session watchdog — detects stuck connections and forces restart
 *  • Staggered startup (300 ms gap so we don't burst-connect 50 sockets)
 *  • Signal-protocol "Closing session" log suppressed (it's normal noise)
 */

'use strict';

const EventEmitter = require('events');
const path         = require('path');
const fs           = require('fs');
const pino         = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const config  = require('../config');
const handler = require('../handler');
const { patchSocket } = require('../utils/sendQueue');

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_SESSIONS  = 50;
const SESSIONS_DIR  = path.join(__dirname, '..', 'sessions');
const RECONNECT_CAP_MS  = 120_000;   // max back-off between reconnect attempts
const RECONNECT_BASE_MS =   5_000;   // initial reconnect delay
const WATCHDOG_INTERVAL = 60_000;    // how often watchdog runs per session
const WATCHDOG_TIMEOUT  = 90_000;    // mark session dead if stuck connecting this long

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ── Baileys version cache — fetched once, reused forever ──────────────────────
let _baileysVersionCache = null;
async function getBaileysVersion() {
  if (!_baileysVersionCache) {
    try {
      const { version } = await fetchLatestBaileysVersion();
      _baileysVersionCache = version;
    } catch (_) {
      _baileysVersionCache = [2, 3000, 1023530]; // safe fallback
    }
  }
  return _baileysVersionCache;
}

// ── Silent pino logger (suppresses "Closing session" noise from Baileys) ──────
function makeLogger() {
  return pino({
    level: 'silent',
    // Even if level were 'error', we suppress everything to keep logs clean
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SESSION_STATUS = {
  IDLE:         'idle',
  CONNECTING:   'connecting',
  QR_READY:     'qr_ready',
  PAIRING:      'pairing',
  CONNECTED:    'connected',
  DISCONNECTED: 'disconnected',
  ERROR:        'error'
};

// ── SessionManager ────────────────────────────────────────────────────────────
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.sessions = new Map();
    this.MAX_SESSIONS = MAX_SESSIONS;
    this._loadPersistedSessions();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  _loadPersistedSessions() {
    try {
      const metaFile = path.join(SESSIONS_DIR, 'sessions.json');
      if (fs.existsSync(metaFile)) {
        const data = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        for (const s of data) {
          this.sessions.set(s.id, this._newSessionObj(s));
        }
        console.log(`[SessionManager] Loaded ${this.sessions.size} persisted sessions`);
      }
    } catch (e) {
      console.error('[SessionManager] Error loading sessions:', e.message);
    }
  }

  _newSessionObj(s) {
    return {
      id:              s.id,
      name:            s.name || `Session ${s.id}`,
      status:          SESSION_STATUS.IDLE,
      sock:            null,
      qrData:          null,
      qrImage:         null,
      connectedNumber: s.connectedNumber || null,
      ownerNumber:     s.ownerNumber || config.ownerNumber[0] || '',
      sessionPath:     path.join(SESSIONS_DIR, `session_${s.id}`),
      createdAt:       s.createdAt || Date.now(),
      autoRestart:     s.autoRestart !== false,
      restartCount:    0,
      _pairingActive:  false,
      _watchdogTimer:  null,
      _connectingAt:   null,
    };
  }

  _persistSessions() {
    try {
      const metaFile = path.join(SESSIONS_DIR, 'sessions.json');
      const data = Array.from(this.sessions.values()).map(s => ({
        id:              s.id,
        name:            s.name,
        connectedNumber: s.connectedNumber,
        ownerNumber:     s.ownerNumber,
        createdAt:       s.createdAt,
        autoRestart:     s.autoRestart
      }));
      fs.writeFileSync(metaFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[SessionManager] Error persisting sessions:', e.message);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  getSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id:              s.id,
      name:            s.name,
      status:          s.status,
      connectedNumber: s.connectedNumber,
      ownerNumber:     s.ownerNumber,
      createdAt:       s.createdAt,
      hasSession:      fs.existsSync(path.join(s.sessionPath, 'creds.json'))
    }));
  }

  getSession(id) { return this.sessions.get(id) || null; }

  createSession(name, ownerNumber) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum ${MAX_SESSIONS} sessions reached`);
    }
    let id = 1;
    while (this.sessions.has(id)) id++;

    const session = this._newSessionObj({
      id,
      name:        name || `Session ${id}`,
      ownerNumber: ownerNumber || config.ownerNumber[0] || '',
      createdAt:   Date.now(),
      autoRestart: true
    });

    fs.mkdirSync(session.sessionPath, { recursive: true });
    this.sessions.set(id, session);
    this._persistSessions();
    this.emit('session:created', { id, name: session.name });
    return session;
  }

  async deleteSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    await this.stopSession(id);
    try {
      if (fs.existsSync(session.sessionPath)) {
        fs.rmSync(session.sessionPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('[SessionManager] Error deleting session files:', e.message);
    }
    this.sessions.delete(id);
    this._persistSessions();
    this.emit('session:deleted', { id });
  }

  async stopSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    session.autoRestart    = false;
    session._pairingActive = false;
    this._clearWatchdog(session);

    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    session.status  = SESSION_STATUS.IDLE;
    session.qrData  = null;
    session.qrImage = null;
    this.emit('session:status', { id, status: session.status });
  }

  async startSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');

    if (session.status === SESSION_STATUS.CONNECTED && session.sock) return;
    if (session._pairingActive) return;

    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    session.autoRestart  = true;
    session.restartCount = 0;
    session.status       = SESSION_STATUS.CONNECTING;
    this.emit('session:status', { id, status: session.status });
    await this._connectSession(id);
  }

  /** Request a pairing code for the given phone number. */
  requestPairCode(id, phoneNumber) {
    return new Promise(async (resolve, reject) => {
      const session = this.sessions.get(id);
      if (!session) return reject(new Error('Session not found'));

      const clean = phoneNumber.replace(/[^0-9]/g, '');
      if (!clean || clean.length < 7) return reject(new Error('Invalid phone number'));

      session._pairingActive = true;

      if (session.sock) {
        try { session.sock.end(undefined); } catch (_) {}
        session.sock = null;
      }

      // Clear existing creds so pairing is clean
      const credsFile = path.join(session.sessionPath, 'creds.json');
      if (fs.existsSync(credsFile)) {
        try {
          fs.rmSync(session.sessionPath, { recursive: true, force: true });
          fs.mkdirSync(session.sessionPath, { recursive: true });
        } catch (_) {}
      }

      const timer = setTimeout(() => {
        session._pairingActive = false;
        reject(new Error('Pairing code timed out. Please try again.'));
      }, 30_000);

      try {
        await this._connectSessionForPairing(id, clean, (err, code) => {
          clearTimeout(timer);
          session._pairingActive = false;
          if (err) reject(err);
          else resolve(code);
        });
      } catch (e) {
        clearTimeout(timer);
        session._pairingActive = false;
        reject(e);
      }
    });
  }

  // ── Internal: watchdog ───────────────────────────────────────────────────────

  _startWatchdog(session) {
    this._clearWatchdog(session);
    session._watchdogTimer = setInterval(() => {
      // If stuck in connecting state for too long, force a reconnect
      if (
        session.status === SESSION_STATUS.CONNECTING &&
        session._connectingAt &&
        Date.now() - session._connectingAt > WATCHDOG_TIMEOUT &&
        session.autoRestart &&
        !session._pairingActive
      ) {
        console.warn(`[Session ${session.id}] Watchdog: stuck in connecting — forcing restart`);
        if (session.sock) {
          try { session.sock.end(undefined); } catch (_) {}
          session.sock = null;
        }
        session.status = SESSION_STATUS.DISCONNECTED;
        this._scheduleReconnect(session);
      }

      // If disconnected and autoRestart but no reconnect was scheduled, retry
      if (
        session.status === SESSION_STATUS.DISCONNECTED &&
        session.autoRestart &&
        !session._pairingActive &&
        !session.sock
      ) {
        console.log(`[Session ${session.id}] Watchdog: dead session — triggering reconnect`);
        this._scheduleReconnect(session);
      }
    }, WATCHDOG_INTERVAL);
    session._watchdogTimer.unref?.();
  }

  _clearWatchdog(session) {
    if (session._watchdogTimer) {
      clearInterval(session._watchdogTimer);
      session._watchdogTimer = null;
    }
  }

  // ── Internal: reconnect scheduler (unlimited, exponential back-off) ──────────

  _scheduleReconnect(session) {
    if (!session.autoRestart || session._pairingActive) return;

    session.restartCount = (session.restartCount || 0) + 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(1.5, session.restartCount - 1),
      RECONNECT_CAP_MS
    );

    console.log(`[Session ${session.id}] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt #${session.restartCount})...`);

    const t = setTimeout(() => {
      if (session.autoRestart && !session._pairingActive) {
        this._connectSession(session.id).catch(e =>
          console.error(`[Session ${session.id}] Reconnect error:`, e.message)
        );
      }
    }, delay);
    t.unref?.();
  }

  // ── Internal: pairing-code connection ────────────────────────────────────────

  async _connectSessionForPairing(id, phoneNumber, callback) {
    const session = this.sessions.get(id);
    if (!session) return callback(new Error('Session not found'));

    try {
      fs.mkdirSync(session.sessionPath, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(session.sessionPath);
      const version = await getBaileysVersion();

      const sock = makeWASocket({
        version,
        logger:              makeLogger(),
        printQRInTerminal:   false,
        browser:             ['Ubuntu', 'Chrome', '20.0.04'],
        auth:                state,
        syncFullHistory:     false,
        downloadHistory:     false,
        markOnlineOnConnect: false,
        getMessage:          async () => undefined,
        connectTimeoutMs:    30_000,
        keepAliveIntervalMs: 15_000,
      });

      patchSocket(sock); // throttle all outgoing messages through rate-limit queue

      session.sock   = sock;
      session.status = SESSION_STATUS.CONNECTING;
      this.emit('session:status', { id, status: session.status });

      let codeDelivered = false;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !codeDelivered) {
          try {
            console.log(`[Session ${id}] 🔢 Requesting pairing code for ${phoneNumber}...`);
            const rawCode = await sock.requestPairingCode(phoneNumber);
            if (!rawCode) throw new Error('Empty code returned');

            codeDelivered = true;
            const formatted = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
            console.log(`[Session ${id}] ✅ Pairing code: ${formatted}`);

            session.status = SESSION_STATUS.PAIRING;
            this.emit('session:status', { id, status: session.status });
            this.emit('session:paircode', { id, code: formatted });
            callback(null, formatted);
          } catch (e) {
            console.error(`[Session ${id}] ❌ Pairing code error:`, e.message);
            if (!codeDelivered) {
              codeDelivered = true;
              callback(new Error('Failed to get pairing code: ' + e.message));
            }
          }
          return;
        }

        if (connection === 'open') {
          session._pairingActive = false;
          session.restartCount   = 0;
          session.status         = SESSION_STATUS.CONNECTED;
          session.qrData         = null;
          session.qrImage        = null;
          session._connectingAt  = null;

          const phoneNum = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
          session.connectedNumber = phoneNum;
          this._persistSessions();
          this.emit('session:connected', { id, number: phoneNum, name: sock.user?.name || '' });
          this.emit('session:status',    { id, status: session.status });
          console.log(`[Session ${id}] ✅ Connected as ${phoneNum}`);

          try { handler.initializeAntiCall(sock); } catch (_) {}
          this._wireMessageHandlers(sock, session);
          this._startWatchdog(session);
          return;
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          session.sock = null;

          if (codeDelivered) {
            const credsFile = path.join(session.sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
              console.log(`[Session ${id}] 🔄 Code accepted — reconnecting with saved credentials...`);
              session._pairingActive = false;
              session.status         = SESSION_STATUS.CONNECTING;
              this.emit('session:status', { id, status: session.status });
              setTimeout(() => {
                this._connectSession(id).catch(e =>
                  console.error(`[Session ${id}] Post-pairing reconnect error:`, e.message)
                );
              }, 1500);
            } else {
              console.log(`[Session ${id}] Connection closed (awaiting code entry, no creds yet)`);
              session.status = SESSION_STATUS.PAIRING;
              this.emit('session:status', { id, status: session.status });
            }
            return;
          }

          session.status = SESSION_STATUS.DISCONNECTED;
          this.emit('session:status',      { id, status: session.status });
          this.emit('session:disconnected', { id, statusCode });
          codeDelivered = true;
          callback(new Error('Connection closed before pairing code. Please try again.'));
        }
      });

      sock.ev.on('creds.update', saveCreds);

    } catch (e) {
      console.error(`[Session ${id}] Pairing setup error:`, e.message);
      callback(e);
    }
  }

  // ── Internal: normal (QR / auto) connection ──────────────────────────────────

  async _connectSession(id) {
    const session = this.sessions.get(id);
    if (!session || session._pairingActive) return;

    // Kill stale socket
    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    try {
      fs.mkdirSync(session.sessionPath, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(session.sessionPath);
      const version = await getBaileysVersion();

      const sock = makeWASocket({
        version,
        logger:              makeLogger(),
        printQRInTerminal:   false,
        browser:             ['Ubuntu', 'Chrome', '20.0.04'],
        auth:                state,
        syncFullHistory:     false,
        downloadHistory:     false,
        markOnlineOnConnect: false,
        getMessage:          async () => undefined,
        connectTimeoutMs:    30_000,
        keepAliveIntervalMs: 15_000,
      });

      patchSocket(sock); // throttle all outgoing messages through rate-limit queue

      session.sock          = sock;
      session.status        = SESSION_STATUS.CONNECTING;
      session._connectingAt = Date.now();
      this.emit('session:status', { id, status: session.status });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR received ─────────────────────────────────────────────────────
        if (qr) {
          session.status  = SESSION_STATUS.QR_READY;
          session.qrData  = qr;
          try {
            session.qrImage = await QRCode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              type:   'image/png',
              margin: 2,
              scale:  6
            });
          } catch (_) { session.qrImage = null; }
          this.emit('session:qr',     { id, qr: session.qrImage });
          this.emit('session:status', { id, status: session.status });
        }

        // ── Connected ───────────────────────────────────────────────────────
        if (connection === 'open') {
          session.status        = SESSION_STATUS.CONNECTED;
          session.qrData        = null;
          session.qrImage       = null;
          session.restartCount  = 0;
          session._connectingAt = null;

          const phoneNum = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
          session.connectedNumber = phoneNum;
          this._persistSessions();
          this.emit('session:connected', { id, number: phoneNum, name: sock.user?.name || '' });
          this.emit('session:status',    { id, status: session.status });
          console.log(`[Session ${id}] ✅ Connected as ${phoneNum}`);

          try { handler.initializeAntiCall(sock); } catch (_) {}
          this._wireMessageHandlers(sock, session);
          this._startWatchdog(session);
        }

        // ── Disconnected ────────────────────────────────────────────────────
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          session.status        = SESSION_STATUS.DISCONNECTED;
          session.sock          = null;
          session._connectingAt = null;
          this.emit('session:status',      { id, status: session.status });
          this.emit('session:disconnected', { id, statusCode });

          console.log(`[Session ${id}] Connection closed (code: ${statusCode})`);

          if (isLoggedOut) {
            // User logged out — don't reconnect, wait for manual re-login
            console.log(`[Session ${id}] Logged out — awaiting re-login`);
            session.connectedNumber = null;
            session.status          = SESSION_STATUS.IDLE;
            this._persistSessions();
            this.emit('session:status', { id, status: session.status });
          } else if (session.autoRestart && !session._pairingActive) {
            this._scheduleReconnect(session);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

    } catch (e) {
      console.error(`[Session ${id}] Connection setup error:`, e.message);
      session.status = SESSION_STATUS.ERROR;
      session.sock   = null;
      this.emit('session:error',  { id, error: e.message });
      this.emit('session:status', { id, status: session.status });
      // Always try to recover
      if (session.autoRestart && !session._pairingActive) {
        this._scheduleReconnect(session);
      }
    }
  }

  // ── Internal: wire message/group event handlers ──────────────────────────────

  _wireMessageHandlers(sock, session) {
    const id = session.id;

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || !msg.key?.id) continue;
        const from = msg.key.remoteJid;
        if (!from || from.includes('@broadcast') || from.includes('@newsletter')) continue;

        // Ignore old messages (> 5 min) on first connect burst
        const age = msg.messageTimestamp ? Date.now() - msg.messageTimestamp * 1000 : 0;
        if (age > 5 * 60 * 1000) continue;

        handler.handleMessage(sock, msg, this._getSessionConfig(session))
          .catch(e => {
            const msg_ = e?.message || '';
            if (!msg_.includes('rate-overlimit') && !msg_.includes('not-authorized')) {
              console.error(`[Session ${id}] Message error:`, msg_);
            }
          });
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      try { await handler.handleGroupUpdate(sock, update); } catch (_) {}
    });

    // Auto-reconnect on unexpected socket errors
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'close') {
        // Already handled above in the outer listener — no-op here
      }
    });
  }

  // ── Config helper ────────────────────────────────────────────────────────────

  _getSessionConfig(session) {
    return { ...config, sessionPath: session.sessionPath };
  }

  // ── Auto-start on boot ───────────────────────────────────────────────────────

  autoStartSessions() {
    let delay = 0;
    for (const [id, session] of this.sessions.entries()) {
      const hasCredentials = fs.existsSync(path.join(session.sessionPath, 'creds.json'));
      if (hasCredentials && session.autoRestart) {
        console.log(`[SessionManager] Auto-starting session ${id} (${session.name})`);
        const t = setTimeout(() => {
          this.startSession(id).catch(e =>
            console.error(`[SessionManager] Auto-start error for session ${id}:`, e.message)
          );
        }, delay);
        t.unref?.();
        delay += 300; // 300 ms stagger — much tighter than the old 2 s per session
      }
    }
  }
}

const mgr = new SessionManager();
module.exports = mgr;
module.exports.SESSION_STATUS = SESSION_STATUS;
