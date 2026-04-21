/**
 * Message Handler — v5 FINAL EDITION
 *
 * OWNER  : 923329838699 (hard-coded, never dynamic)
 * STATUS : Auto-read + 👀 react + log to data/status_log.json — ALWAYS ON
 * NSFW   : Delete + Kick on image/video/sticker — ALWAYS ON, owner exempt
 *
 * Performance:
 *  1. isAdmin/isBotAdmin use cached metadata — zero live fetches per message
 *  2. Shields only trigger on image/video/sticker/text (skip audio/doc/reaction)
 *  3. MAX_CONCURRENT = 8 (Render Free: 512 MB / 1 vCPU)
 *  4. API timeouts = 4 s with instant text fallback
 *  5. Cache cleanup every 5 min — lidMappingCache capped at 2000
 */

process.on('uncaughtException',   (err)    => console.error('[FATAL] UncaughtException:', err));
process.on('unhandledRejection',  (reason) => console.error('[FATAL] UnhandledRejection:', reason));

const config   = require('./config');
const database = require('./database');
const { loadCommands }         = require('./utils/commandLoader');
const { addMessage }           = require('./utils/groupstats');
const { jidDecode, jidEncode, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { scanImageBuffer }      = require('./utils/nsfwScanner');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');

// ── PERF #3: Concurrency tuned for Render Free (512 MB / 1 vCPU) ──────────────
const MAX_CONCURRENT = 8;   // was 20 — too many parallel awaits on 1 vCPU causes thrashing
const QUEUE_CAP      = 50;  // drop oldest tasks instead of unbounded queue growth
let   activeHandlers = 0;
const pendingQueue   = [];

// ── Auto Re-Add: anti-loop cooldown (60 s per user per group) ─────────────────
// Key = "groupId:userJid", Value = timestamp of last re-add attempt
const reAddCooldown = new Map();

function runWithQueue(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeHandlers++;
      Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeHandlers--;
          if (pendingQueue.length > 0) pendingQueue.shift()();
        });
    };
    if (activeHandlers < MAX_CONCURRENT) {
      task();
    } else {
      if (pendingQueue.length >= QUEUE_CAP) pendingQueue.shift(); // drop oldest
      pendingQueue.push(task);
    }
  });
}

// ── PERF #5: Tightened cache constants ────────────────────────────────────────
const CACHE_TTL         = 90_000;    // 90 s metadata cache (was 60 s — too aggressive refetch)
const MAX_CACHE_SZ      = 300;       // was 500
const MAX_WARN_SZ       = 500;       // was 1000
const MSG_CACHE_TTL     = 20 * 60 * 1000;  // 20 min (was 30)
const MAX_MSG_CACHE     = 2000;      // was 5000
const RESTORED_TTL      = 30 * 60 * 1000;  // 30 min (was 60)
const MAX_RESTORED_SZ   = 3000;      // was 10000
const MAX_LID_CACHE_SZ  = 2000;      // new — prevents LID map from growing unbounded
const AUTO_REACT_COOLDOWN = 4000;    // was 3000

const groupMetadataCache   = new Map();
const linkWarnings         = new Map();
const middleFingerWarnings = new Map();
const userMsgRate          = new Map();
const userRepeatMsg        = new Map();
const msgCache             = new Map();
const restoredMessages     = new Map();
const autoReactLastSent    = new Map();
const lidMappingCache      = new Map();

// ── PERF #5: Cleanup runs every 5 min (was 10) — keeps RAM lean ───────────────
setInterval(() => {
  try {
    const now = Date.now();
    const evict = (map, maxSz) => {
      if (map.size > maxSz) {
        const overflow = map.size - maxSz;
        let n = 0;
        for (const k of map.keys()) { if (n++ >= overflow) break; map.delete(k); }
      }
    };

    for (const [k, v] of groupMetadataCache) if (now - v.timestamp > CACHE_TTL * 4) groupMetadataCache.delete(k);
    evict(groupMetadataCache, MAX_CACHE_SZ);

    for (const map of [linkWarnings, middleFingerWarnings]) evict(map, MAX_WARN_SZ);

    for (const [k, ts] of autoReactLastSent) if (now - ts > AUTO_REACT_COOLDOWN * 10) autoReactLastSent.delete(k);

    for (const [k, v] of userMsgRate)   if (now - v.windowStart > 30_000) userMsgRate.delete(k);
    for (const [k, v] of userRepeatMsg) if (now - (v.lastTime || 0) > 60_000) userRepeatMsg.delete(k);

    for (const [k, v] of msgCache) if (now - v.timestamp > MSG_CACHE_TTL) msgCache.delete(k);
    evict(msgCache, MAX_MSG_CACHE);

    for (const [k, ts] of restoredMessages) if (now - ts > RESTORED_TTL) restoredMessages.delete(k);
    evict(restoredMessages, MAX_RESTORED_SZ);

    evict(lidMappingCache, MAX_LID_CACHE_SZ);

    // Clean up bot-admin cache (groups where bot is no longer present)
    for (const [k, v] of _botAdminCache) if (now - v.ts > BOT_ADMIN_TTL * 10) _botAdminCache.delete(k);

    // Invalidate banned users cache so it reloads fresh next command
    if (_bannedCache && now - _bannedCacheTs > BANNED_CACHE_TTL) { _bannedCache = null; _bannedCacheTs = 0; }
  } catch (_) {}
}, 5 * 60 * 1000).unref();

const commands = loadCommands();

const { handleCompetitorBot } = require('./utils/antiBot');
// handleNsfwShield intentionally NOT used — inline always-on NSFW shield handles this fully

// ── Module-level requires for hot-path modules (Node caches, but avoid repeated lookups) ──
let _autoReactModule = null;
const getAutoReact = () => {
  try {
    if (!_autoReactModule) _autoReactModule = require('./utils/autoReact');
    return _autoReactModule.load ? _autoReactModule.load() : null;
  } catch { return null; }
};

let _chatbotModule = null;
const getChatbot = () => {
  try {
    if (!_chatbotModule) _chatbotModule = require('./Commands/admin/chatbot');
    return _chatbotModule;
  } catch { return null; }
};

let _bombModule = null;
const getBomb = () => {
  try {
    if (!_bombModule) _bombModule = require('./Commands/fun/bomb');
    return _bombModule;
  } catch { return null; }
};

let _tttModule = null;
const getTtt = () => {
  try {
    if (!_tttModule) _tttModule = require('./Commands/fun/tictactoe');
    return _tttModule;
  } catch { return null; }
};

// ── Banned users cache — avoid per-command synchronous file reads ──────────────
let _bannedCache = null;
let _bannedCacheTs = 0;
const BANNED_CACHE_TTL = 60_000; // refresh every 60 s
const getBannedUsers = () => {
  const now = Date.now();
  if (_bannedCache && now - _bannedCacheTs < BANNED_CACHE_TTL) return _bannedCache;
  try {
    const p = path.join(__dirname, 'data', 'banned.json');
    _bannedCache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  } catch { _bannedCache = []; }
  _bannedCacheTs = now;
  return _bannedCache;
};

// ── HARD-LOCKED owner — only 923329838699 is ever the owner ──────────────────
// No dynamic session logic. No .map(). No config array traversal per message.
const OWNER_NUMBER = '923329838699';

const isOwnerNumber   = (n) => String(n).replace(/[^0-9]/g, '') === OWNER_NUMBER;
const getOwnerPhone   = () => OWNER_NUMBER;
const getOwnerPhones  = () => [OWNER_NUMBER];
const getOwnerJid     = () => `${OWNER_NUMBER}@s.whatsapp.net`;
const getOwnerJids    = () => [`${OWNER_NUMBER}@s.whatsapp.net`];

const OWNER_ONLINE_TTL = 5 * 60 * 1000;
let ownerLastSeenOnline = 0;

// ── Message content unwrapper ─────────────────────────────────────────────────
const getMessageContent = (msg) => {
  if (!msg?.message) return null;
  let m = msg.message;
  if (m.ephemeralMessage)           m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2)          m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage)            m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return m;
};

// ── PERF #1: Group metadata — always cached first ─────────────────────────────
const getCachedGroupMetadata = async (sock, groupId) => {
  if (!groupId?.endsWith('@g.us')) return null;
  const cached = groupMetadataCache.get(groupId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  try {
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, { data: metadata, timestamp: Date.now() });
    return metadata;
  } catch (err) {
    const is403 = err.message?.includes('forbidden') || err.message?.includes('403') ||
                  err.statusCode === 403 || err.data === 403;
    if (is403) { groupMetadataCache.set(groupId, { data: null, timestamp: Date.now() }); return null; }
    return cached?.data ?? null;
  }
};

// getLiveGroupMetadata only used when we MUST have fresh admin list (bot admin check, once per msg)
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, { data: metadata, timestamp: Date.now() });
    return metadata;
  } catch {
    return groupMetadataCache.get(groupId)?.data ?? null;
  }
};

const getGroupMetadata = getCachedGroupMetadata;

const isMod = (sender) => database.isModerator(sender.split('@')[0]);

// ── LID utilities ─────────────────────────────────────────────────────────────
const getLidMappingValue = (user, direction) => {
  if (!user) return null;
  const cacheKey = `${direction}:${user}`;
  if (lidMappingCache.has(cacheKey)) return lidMappingCache.get(cacheKey);

  const suffix   = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filename = `lid-mapping-${user}${suffix}`;
  const searchDirs = [];

  const sessionsBase = path.join(__dirname, 'sessions');
  try {
    if (fs.existsSync(sessionsBase)) {
      for (const entry of fs.readdirSync(sessionsBase)) {
        if (entry.startsWith('session_')) searchDirs.push(path.join(sessionsBase, entry));
      }
    }
  } catch (_) {}
  searchDirs.push(path.join(__dirname, config.sessionName || 'session'));

  for (const dir of searchDirs) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw   = fs.readFileSync(filePath, 'utf8').trim();
      const value = raw ? JSON.parse(raw) : null;
      if (value != null) { lidMappingCache.set(cacheKey, value); return value; }
    } catch (_) {}
  }
  lidMappingCache.set(cacheKey, null);
  return null;
};

const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    let user   = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) { user = pnUser; server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'; return true; }
      return false;
    };
    if (server === 'lid' || server === 'hosted.lid') mapToPn();
    else if (server === 's.whatsapp.net' || server === 'hosted') mapToPn();
    return server === 'hosted' ? jidEncode(user, 'hosted') : jidEncode(user, 's.whatsapp.net');
  } catch { return jid; }
};

const buildComparableIds = (jid) => {
  if (!jid) return [];
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return [normalizeJidWithLid(jid)].filter(Boolean);
    const variants = new Set();
    const ns = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    variants.add(jidEncode(decoded.user, ns));
    if (ns === 's.whatsapp.net' || ns === 'hosted') {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) variants.add(jidEncode(lidUser, ns === 'hosted' ? 'hosted.lid' : 'lid'));
    } else if (ns === 'lid' || ns === 'hosted.lid') {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) variants.add(jidEncode(pnUser, ns === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'));
    }
    return Array.from(variants);
  } catch { return [jid]; }
};

const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));
  if (!targets.length) return null;
  return participants.find(p => {
    if (!p) return false;
    const pIds = [p.id, p.lid, p.userJid].filter(Boolean).flatMap(id => buildComparableIds(id));
    return pIds.some(id => targets.includes(id));
  }) || null;
};

// ── PERF #1: isAdmin — uses passed-in metadata (cached). NO live fetch. ───────
const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant || !groupId?.endsWith('@g.us')) return false;

  // Use whatever metadata was passed in; if missing, fetch cached (not live).
  const meta = groupMetadata?.participants
    ? groupMetadata
    : await getCachedGroupMetadata(sock, groupId);
  if (!meta?.participants) return false;

  const found = findParticipant(meta.participants, participant);
  if (found) return found.admin === 'admin' || found.admin === 'superadmin';

  const senderUser = participant.split('@')[0].split(':')[0];
  let senderPhone = senderUser;
  if (participant.includes('@lid') || participant.includes('@hosted.lid')) {
    const resolved = getLidMappingValue(senderUser, 'lidToPn');
    if (resolved) senderPhone = String(resolved);
  }

  const fallback = meta.participants.find(p => {
    const pid = (p.id || '').split('@')[0].split(':')[0];
    if (!pid) return false;
    if (pid === senderPhone || pid === senderUser) return true;
    if ((p.id || '').includes('@lid')) {
      const rp = getLidMappingValue(pid, 'lidToPn');
      if (rp && String(rp) === senderPhone) return true;
    }
    return false;
  });

  return fallback ? fallback.admin === 'admin' || fallback.admin === 'superadmin' : false;
};

// ── PERF #1: isBotAdmin — live fetch with short-lived cache ──────────────────
const _botAdminCache = new Map(); // groupId → { result, ts }
const BOT_ADMIN_TTL  = 20_000;   // 20 s — short enough to catch recent promotions

// Forcibly expire a group's bot-admin cache entry (call on promote/demote events)
const invalidateBotAdminCache = (groupId) => _botAdminCache.delete(groupId);

const isBotAdmin = async (sock, groupId, _groupMetadata = null) => {
  // _groupMetadata parameter is intentionally IGNORED here.
  // We never trust a passed-in (potentially stale) metadata for the bot's own
  // admin status — we always hit the live API (then cache for 20 s).
  if (!sock.user || !groupId?.endsWith('@g.us')) return false;

  const cached = _botAdminCache.get(groupId);
  if (cached && Date.now() - cached.ts < BOT_ADMIN_TTL) return cached.result;

  try {
    const botRawId = sock.user.id;
    if (!botRawId) return false;
    const botNum   = botRawId.split(':')[0].split('@')[0];   // pure phone number
    const botPnId  = botNum + '@s.whatsapp.net';
    const botJids  = [botRawId, botPnId];
    if (sock.user.lid) botJids.push(sock.user.lid);

    // ALWAYS fetch live — this is the only way to get the current admin status.
    // getLiveGroupMetadata also refreshes the groupMetadataCache as a side-effect.
    const meta = await getLiveGroupMetadata(sock, groupId);
    if (!meta?.participants) {
      _botAdminCache.set(groupId, { result: false, ts: Date.now() });
      return false;
    }

    // Pass 1: use the full findParticipant (handles LID ↔ phone mapping)
    let p = findParticipant(meta.participants, botJids);

    // Pass 2: numeric fallback — strip everything after @ and : then compare
    if (!p) {
      p = meta.participants.find(p2 => {
        const pid = (p2.id || '').split(':')[0].split('@')[0];
        if (pid === botNum) return true;
        // Try resolving LID to phone number
        if ((p2.id || '').includes('@lid')) {
          const resolved = getLidMappingValue(pid, 'lidToPn');
          if (resolved && String(resolved) === botNum) return true;
        }
        return false;
      });
    }

    // Pass 3: if sock.user.lid exists compare that too
    if (!p && sock.user.lid) {
      const lidNum = sock.user.lid.split(':')[0].split('@')[0];
      p = meta.participants.find(p2 => {
        const pid = (p2.id || '').split(':')[0].split('@')[0];
        return pid === lidNum;
      });
    }

    const result = !!(p && (p.admin === 'admin' || p.admin === 'superadmin'));
    _botAdminCache.set(groupId, { result, ts: Date.now() });
    console.log(`[BOTADMIN] ${groupId.split('@')[0]} → bot admin=${result} (participant=${p?.id ?? 'not found'})`);
    return result;
  } catch (err) {
    console.error('[BOTADMIN] Error:', err.message);
    return false;
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || jid.includes('status.broadcast') ||
         jid.includes('@newsletter') || jid.includes('@newsletter.');
};

// ── NSFW enforcement — delete + immediate kick, owner hard-coded exception ────
const enforceNsfw = async (sock, msg, from, sender, groupMetadata, reason) => {
  // Step 1: Delete the message immediately, no matter what
  try {
    await sock.sendMessage(from, {
      delete: { remoteJid: from, fromMe: false, id: msg.key.id, participant: msg.key.participant || sender }
    });
  } catch (_) {}

  // Step 2: Hard-coded owner guard — NEVER kick 923329838699
  const _resolvedSender = normalizeJidWithLid(sender);
  const senderNum = _resolvedSender.split('@')[0].split(':')[0];
  const rawSenderNum = sender.split('@')[0].split(':')[0];
  if (senderNum === '923329838699' || rawSenderNum === '923329838699') return;

  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
  if (botIsAdmin) {
    try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
    try {
      await sock.sendMessage(from, {
        text: `🚫 *NSFW Content — User Removed*\n\n@${sender.split('@')[0]} has been removed.\n\n📌 Reason: ${reason}\n🛡️ NSFW protection active.`,
        mentions: [sender]
      });
    } catch (_) {}
  } else {
    try {
      await sock.sendMessage(from, {
        text: `⚠️ *NSFW Content Detected & Deleted*\n\n@${sender.split('@')[0]}\n📌 Reason: ${reason}\n⚠️ Bot needs admin rights to remove the user.`,
        mentions: [sender]
      });
    } catch (_) {}
  }
};

// ── Bot signature patterns ────────────────────────────────────────────────────
const BOT_SIGNATURES = [
  /powered\s+by\s+xeon/i, /xeon\s*bot/i, /cheems[\s\-_]*bot/i, /ᴄʜᴇᴇᴍs/i,
  /mr[\.\s\-]*perfect\s*bot/i, /zaira[\s\-_]*(bot|md)/i, /whatsapp\s*bot\s*md/i,
  /wamellow/i, /stickermaker/i, /\b(miki|pika|kitsune|rose|rika|naze|ryo|suki)\s*bot\b/i,
  /baileys[\s\-]*bot/i, /baileys[\s\-]*md/i, /©\s*\w+\s*bot/i,
  /\bprimebotmd\b/i, /\bmd\s*bot\b/i, /\bwhatsapp\s*md\b/i, /\byoubot\b/i,
  /\bstarkbot\b/i, /\baxibot\b/i, /\bneonbot\b/i, /\bcyberbot\b/i,
  /\bnexusbot\b/i, /\bstealthbot\b/i, /\bmd\s*pro\b/i, /\bbot\s*pro\b/i,
  /this\s+(is\s+an?\s+)?(automated|auto)\s+(reply|message|response)/i,
  /sent\s+via\s+\w+\s*bot/i, /bot\s*made\s*by/i,
  /^[─━═]{5,}$/m, /^[\*\-=]{5,}$/m,
  /\u200b{3,}/, /[\uE000-\uF8FF]{3,}/,
  /^(auto[\s\-_]?reply|autoresponder|bot\s*reply)[:：]/i,
];

// ── Rate tracker ──────────────────────────────────────────────────────────────
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MSG   = 8;
const REPEAT_MAX     = 5;

const updateAndCheckRate = (sender, textBody) => {
  const now  = Date.now();
  const rate = userMsgRate.get(sender) || { count: 0, windowStart: now };
  if (now - rate.windowStart > RATE_WINDOW_MS) { rate.count = 1; rate.windowStart = now; }
  else rate.count++;
  userMsgRate.set(sender, rate);
  if (rate.count > RATE_MAX_MSG) return { flagged: true, reason: 'Message flood (spam bot)' };

  if (textBody?.length > 5) {
    const rep = userRepeatMsg.get(sender) || { lastText: '', count: 0, lastTime: 0 };
    rep.count  = rep.lastText === textBody ? rep.count + 1 : 1;
    rep.lastText = textBody;
    rep.lastTime = now;
    userRepeatMsg.set(sender, rep);
    if (rep.count >= REPEAT_MAX) return { flagged: true, reason: 'Repeated identical messages (bot pattern)' };
  }
  return { flagged: false, reason: '' };
};

// ── Main message handler ──────────────────────────────────────────────────────
const handleMessage = async (sock, msg) => {
  try {
    // HARD-LOCKED owner check — exactly as specified, no config lookups, no session logic
    // normalizeJidWithLid resolves LID JIDs to phone-number JIDs before comparing
    const isOwner = (sender) => {
      if (!sender) return false;
      const resolved = normalizeJidWithLid(sender);
      const senderNum = resolved.split('@')[0].split(':')[0];
      if (senderNum === '923329838699') return true;
      // Fallback: also check the raw sender in case LID mapping not yet loaded
      const rawNum = sender.split('@')[0].split(':')[0];
      return rawNum === '923329838699';
    };

    if (!msg.message) return;
    const from = msg.key.remoteJid;

    // ── Auto-status: view + react + log ──────────────────────────────────────
    if (from === 'status@broadcast') {
      const statusSender = msg.key.participant || msg.key.remoteJid;
      try {
        // Mark status as SEEN (shows the blue eye to the sender)
        // Explicit key format ensures Baileys sends the correct read receipt
        await sock.readMessages([{
          remoteJid  : 'status@broadcast',
          id         : msg.key.id,
          participant: statusSender,
          fromMe     : false
        }]);
      } catch (_) {}

      // React with 👀 so the sender knows the bot viewed their status
      try {
        await sock.sendMessage('status@broadcast', {
          react: { text: '👀', key: msg.key }
        }, { statusJidList: [statusSender] });
      } catch (_) {}

      // Log for panel / admin review
      try {
        const statusContent = getMessageContent(msg);
        const statusText    = statusContent?.conversation ||
                              statusContent?.extendedTextMessage?.text ||
                              statusContent?.imageMessage?.caption ||
                              statusContent?.videoMessage?.caption || '';
        console.log(`[STATUS-VIEW] ${statusSender}: ${statusText.substring(0, 80) || '(media)'}`);

        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const logPath = path.join(dataDir, 'status_log.json');
        let log = [];
        try { if (fs.existsSync(logPath)) log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch (_) {}
        log.push({
          sender   : statusSender,
          timestamp: Date.now(),
          text     : statusText || null,
          hasMedia : !!(statusContent?.imageMessage || statusContent?.videoMessage || statusContent?.audioMessage)
        });
        if (log.length > 500) log = log.slice(-500);
        fs.writeFile(logPath, JSON.stringify(log, null, 2), () => {});
      } catch (e) { console.error('[STATUS-VIEW]', e.message); }
      return;
    }

    if (isSystemJid(from)) return;

    // ── Anti-delete: deletion events ──────────────────────────────────────────
    if (msg.message?.protocolMessage?.type === 0 && from.endsWith('@g.us')) {
      try {
        const deletedKey = msg.message.protocolMessage.key;
        const deletedId  = deletedKey?.id;
        if (deletedId && msgCache.has(deletedId)) {
          if (restoredMessages.has(deletedId)) { msgCache.delete(deletedId); return; }

          const groupMeta    = await getCachedGroupMetadata(sock, from).catch(() => null);
          const deleterJid   = msg.key.participant || msg.key.remoteJid;
          const deleterAdmin = groupMeta ? await isAdmin(sock, deleterJid, from, groupMeta).catch(() => false) : false;
          const deleterOwner = isOwner(deleterJid);

          if (deleterAdmin || deleterOwner) { msgCache.delete(deletedId); return; }

          restoredMessages.set(deletedId, Date.now());
          const cached = msgCache.get(deletedId);
          msgCache.delete(deletedId);

          const groupName = groupMeta?.subject || from.split('@')[0];
          const userName  = deleterJid.split('@')[0].split(':')[0];
          const cachedMsg = cached.msg;
          const cachedContent = cachedMsg.message?.ephemeralMessage?.message ||
                                cachedMsg.message?.viewOnceMessageV2?.message ||
                                cachedMsg.message?.viewOnceMessage?.message ||
                                cachedMsg.message?.documentWithCaptionMessage?.message ||
                                cachedMsg.message;

          const skip    = ['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'];
          const typeKey = cachedContent ? Object.keys(cachedContent).find(k => !skip.includes(k)) : null;

          const isImage   = typeKey === 'imageMessage';
          const isVideo   = typeKey === 'videoMessage';
          const isSticker = typeKey === 'stickerMessage';
          const isAudio   = typeKey === 'audioMessage';
          const isDoc     = typeKey === 'documentMessage';
          const isText    = typeKey === 'conversation' || typeKey === 'extendedTextMessage';

          const label = isImage ? 'Image' : isVideo ? 'Video' : isSticker ? 'Sticker' :
                        isAudio ? 'Audio' : isDoc ? 'Document' : 'Text';

          const textContent = cachedContent?.conversation ||
                              cachedContent?.extendedTextMessage?.text ||
                              cachedContent?.imageMessage?.caption ||
                              cachedContent?.videoMessage?.caption ||
                              cachedContent?.documentMessage?.caption || '';

          const header = `╔═══「 Anti Delete Alert 」═══╗\n👥 Group: ${groupName}\n👤 User: @${userName}\n📩 Type: ${label}\n`;
          const footer = `╚═══════════════════════╝\n\n⚡ Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`;

          if (isText) {
            await sock.sendMessage(from, { text: `${header}📝 Message: ${textContent || '(empty)'}\n${footer}`, mentions: [deleterJid] });
          } else if (isImage || isVideo || isSticker || isAudio || isDoc) {
            let buf = null;
            try { buf = await downloadMediaMessage(cachedMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }); } catch (_) {}
            const cap = `${header}${textContent ? `📝 Caption: ${textContent}\n` : ''}${footer}`;
            if (buf?.length > 0) {
              if (isImage)   await sock.sendMessage(from, { image: buf, caption: cap, mentions: [deleterJid] });
              else if (isVideo)   await sock.sendMessage(from, { video: buf, caption: cap, mentions: [deleterJid] });
              else if (isSticker) { await sock.sendMessage(from, { sticker: buf }); await sock.sendMessage(from, { text: cap, mentions: [deleterJid] }); }
              else if (isAudio)   { await sock.sendMessage(from, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }); await sock.sendMessage(from, { text: cap, mentions: [deleterJid] }); }
              else if (isDoc) {
                const fn = cachedContent?.documentMessage?.fileName || 'document';
                const mt = cachedContent?.documentMessage?.mimetype || 'application/octet-stream';
                await sock.sendMessage(from, { document: buf, fileName: fn, mimetype: mt, caption: cap, mentions: [deleterJid] });
              }
            } else {
              await sock.sendMessage(from, { text: `${header}📝 Message: ⚠️ Media not available, but message was deleted.\n${footer}`, mentions: [deleterJid] });
            }
          }
        }
      } catch (e) { console.error('[AntiDelete]', e.message); }
      return;
    }

    // ── Auto-react (rate-limited, fire-and-forget) ────────────────────────────
    try {
      const arCfg = getAutoReact();
      if (arCfg?.enabled && msg.message && !msg.key.fromMe) {
        const jid     = msg.key.remoteJid;
        const lastSent = autoReactLastSent.get(jid) || 0;
        const now      = Date.now();
        if (now - lastSent >= AUTO_REACT_COOLDOWN) {
          autoReactLastSent.set(jid, now);
          const c = msg.message.ephemeralMessage?.message || msg.message;
          const text = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
          const emojis = ['❤️','🖤','🤍','💛','💚','💙','💜','🧡','❤️‍🔥','💗','🔥','⚡','💥','💫','✨','🌟','💀','🦅','🦁','🐺','💎','👑','🏆','⚔️','🛡️','🔮','🪐','🚀','😎','🥶','😈','👿','🤯','😏'];
          const mode = arCfg.mode || 'all';
          const rand = emojis[Math.floor(Math.random() * emojis.length)];
          const isCmd = ['.', '/', '!', '#'].includes(text?.trim()?.[0]);
          sock.sendMessage(jid, { react: { text: (mode === 'bot') ? (isCmd ? '⏳' : rand) : rand, key: msg.key } }).catch(() => {});
        }
      }
    } catch (_) {}

    const content = getMessageContent(msg);
    let actualMessageTypes = [];
    if (content) {
      const skip = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = Object.keys(content).filter(k => !skip.includes(k));
    }

    const sender = msg.key.fromMe
      ? sock.user.id.split(':')[0] + '@s.whatsapp.net'
      : (msg.key.participant || msg.key.remoteJid);
    const isGroup = from.endsWith('@g.us');

    // PERF #1: Single cached fetch for the whole message lifecycle
    const groupMetadata = isGroup ? await getCachedGroupMetadata(sock, from) : null;

    // ── Anti-delete: cache incoming messages ──────────────────────────────────
    if (isGroup && !msg.key.fromMe && msg.key.id) {
      try {
        const skip   = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
        const hasReal = Object.keys(msg.message || {}).some(k => !skip.includes(k));
        if (hasReal) msgCache.set(msg.key.id, { msg, from, sender, timestamp: Date.now() });
      } catch (_) {}
    }

    // ── NSFW SHIELD — Smart adult-content detection only ─────────────────────
    // Funny images, funny videos, funny stickers → ALLOWED
    // Only adult/dirty content is removed (checked via caption, emoji tags, and adult keywords)
    // Owner (923329838699) and group admins are NEVER affected.
    try {
      if (isGroup && groupMetadata && !msg.key.fromMe) {
        const _nsfwResolved = normalizeJidWithLid(sender);
        const senderNum     = _nsfwResolved.split('@')[0].split(':')[0];
        const senderIsOwner = senderNum === '923329838699' || sender.split('@')[0].split(':')[0] === '923329838699';

        if (!senderIsOwner) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);

          if (!senderIsAdmin) {
            const mc = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessageV2?.message ||
                       msg.message?.viewOnceMessage?.message || msg.message?.documentWithCaptionMessage?.message || msg.message;

            const skip     = ['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'];
            const mediaKey = Object.keys(mc || {}).find(k => !skip.includes(k));

            // ── Adult keyword / link lists ────────────────────────────────────
            const adultLinks = [
              'xnxx.com','xvideos.com','pornhub.com','xhamster.com','redtube.com',
              'youporn.com','brazzers.com','onlyfans.com','fapello.com','thothub.tv',
              'nudostar.com','nudogram.com','sexvid.xxx','beeg.com','hclips.com',
              'hdzog.com','drtuber.com','ah-me.com','rule34.xxx','nhentai.net',
              'hentaihaven.xxx','hentai.tv'
            ];
            const adultWords = [
              'xxx','porn','nude','naked','18+','explicit','erotic',
              'rule34','xnxx','xvideos','pornhub','onlyfans','lewd',
              'hentai','bdsm','fetish','pussy','vagina','penis','cock','dick',
              'boobs','tits','nipple','blowjob','handjob','masturbat','orgasm',
              'camgirl','sexting','nudes','sex video','sex clip','sex tape',
              'nude video','nude photo','nude pic','strip tease',
              'lund','choot','gaand','nangi','chudai','randi','blue film','gandi video',
              'bf video','sexy video','leaked video','private video',
              'كس','زب','بزاز','سكس','نيك','عاهرة','إباحي'
            ];
            // Adult sticker emoji tags
            const adultStickerEmojis = ['🔞','🍑','🍆','💦','👅','🫦'];

            const isAdultCaption = (text) => {
              if (!text) return false;
              const t = text.toLowerCase();
              return adultLinks.some(l => t.includes(l)) || adultWords.some(w => t.includes(w));
            };

            // ── Sticker: only remove if adult emoji tag ───────────────────────
            if (mediaKey === 'stickerMessage') {
              const emoji = (mc?.stickerMessage?.associatedEmoji || '').toLowerCase();
              if (adultStickerEmojis.some(e => emoji.includes(e))) {
                await enforceNsfw(sock, msg, from, sender, groupMetadata, '🔞 Adult sticker detected');
                return;
              }
              // Funny / normal sticker → allowed, do nothing
            }

            // ── Image: check caption AND scan actual pixels ───────────────────
            else if (mediaKey === 'imageMessage') {
              const caption = mc?.imageMessage?.caption || '';

              // 1. Caption check (instant)
              if (isAdultCaption(caption)) {
                await enforceNsfw(sock, msg, from, sender, groupMetadata, '🔞 Adult image caption detected');
                return;
              }

              // 2. Pixel scan — download image and run skin-tone analysis
              try {
                const imgBuf = await downloadMediaMessage(
                  msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }
                );
                const { nsfw, reason } = await scanImageBuffer(imgBuf);
                if (nsfw) {
                  await enforceNsfw(sock, msg, from, sender, groupMetadata, `🔞 Adult image detected (${reason})`);
                  return;
                }
              } catch (_scanErr) {
                // If download/scan fails, do not punish — allow the image
              }
              // Funny / normal image → allowed
            }

            // ── Video: check caption AND scan embedded thumbnail ──────────────
            else if (mediaKey === 'videoMessage') {
              const caption = mc?.videoMessage?.caption || '';

              // 1. Caption check (instant)
              if (isAdultCaption(caption)) {
                await enforceNsfw(sock, msg, from, sender, groupMetadata, '🔞 Adult video caption detected');
                return;
              }

              // 2. Scan the JPEG thumbnail that WhatsApp embeds in every video message
              // (No need to download the full video — the thumbnail is a snapshot of the content)
              try {
                const thumb = mc?.videoMessage?.jpegThumbnail;
                if (thumb && thumb.length > 500) {
                  const { nsfw, reason } = await scanImageBuffer(Buffer.from(thumb));
                  if (nsfw) {
                    await enforceNsfw(sock, msg, from, sender, groupMetadata, `🔞 Adult video thumbnail detected (${reason})`);
                    return;
                  }
                }
              } catch (_scanErr) {
                // Thumbnail scan failed — allow the video
              }
              // Funny / normal video → allowed
            }

            // ── Text / links: block adult links and explicit text ─────────────
            else {
              const msgText = [
                mc?.conversation,
                mc?.extendedTextMessage?.text,
                mc?.documentMessage?.caption
              ].filter(Boolean).join(' ');

              if (msgText && isAdultCaption(msgText)) {
                await enforceNsfw(sock, msg, from, sender, groupMetadata, '🔞 Adult text/link detected');
                return;
              }
            }
          }
        }
      }
    } catch (e) { console.error('[NSFW]', e.message); }

    // ── Advanced bot detector ─────────────────────────────────────────────────
    try {
      if (isGroup && groupMetadata && !msg.key.fromMe) {
        const gs = database.getGroupSettings(from);
        if (gs.antiuserbot) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          const senderIsOwner = isOwner(sender);
          const botIsAdmin    = await isBotAdmin(sock, from, groupMetadata);

          if (!senderIsAdmin && !senderIsOwner && botIsAdmin) {
            const rc = msg.message?.ephemeralMessage?.message || msg.message || {};
            const tb = [rc?.conversation, rc?.extendedTextMessage?.text, rc?.imageMessage?.caption, rc?.videoMessage?.caption]
                       .filter(Boolean).join(' ');
            const forwardScore = rc?.extendedTextMessage?.contextInfo?.forwardingScore || 0;
            const hasBotSig    = BOT_SIGNATURES.some(r => r.test(tb));
            const { flagged: isBehav, reason: bReason } = updateAndCheckRate(sender, tb.trim());

            if (hasBotSig || forwardScore > 50 || isBehav) {
              const reason = hasBotSig ? 'Bot signature' : forwardScore > 50 ? 'Mass-forward flood' : bReason;
              try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); database.clearWarnings(from, sender); } catch (_) {}
              try { await sock.sendMessage(from, { text: `🤖 *Bot Detected & Removed*\n\n@${sender.split('@')[0]} removed.\n📌 ${reason}\n🛡️ Group protection active.`, mentions: [sender] }); } catch (_) {}
            }
          }
        }
      }
    } catch (e) { console.error('[BotDetector]', e.message); }

    // ── Anti-spam ─────────────────────────────────────────────────────────────
    try {
      if (isGroup && groupMetadata && !msg.key.fromMe) {
        const gs = database.getGroupSettings(from);
        if (gs.antiSpam) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          const senderIsOwner = isOwner(sender);
          const botIsAdmin    = await isBotAdmin(sock, from, groupMetadata);

          if (!senderIsAdmin && !senderIsOwner && botIsAdmin) {
            const rc = msg.message?.ephemeralMessage?.message || msg.message || {};
            const tb = [rc?.conversation, rc?.extendedTextMessage?.text, rc?.imageMessage?.caption, rc?.videoMessage?.caption]
                       .filter(Boolean).join(' ').trim();
            const { flagged, reason } = updateAndCheckRate(sender, tb);
            if (flagged) {
              try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
              try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
              try { await sock.sendMessage(from, { text: `🚫 *Spam Detected — User Removed*\n\n@${sender.split('@')[0]} removed.\n📌 ${reason}`, mentions: [sender] }); } catch (_) {}
            }
          }
        }
      }
    } catch (e) { console.error('[AntiSpam]', e.message); }

    // ── PERF #2: Competitor-bot shield — only for text/link message types ─────
    // NSFW is already handled above (inline always-on). handleNsfwShield removed.
    if (isGroup && groupMetadata && !msg.key.fromMe) {
      const compTypes = new Set(['extendedTextMessage','conversation']);
      if (actualMessageTypes.some(t => compTypes.has(t))) {
        try {
          const [senderIsAdmin, botIsAdmin] = await Promise.all([
            isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin(sock, from, groupMetadata)
          ]);
          handleCompetitorBot(sock, msg, groupMetadata, {
            sender, from, senderIsAdmin, senderIsOwner: isOwner(sender), botIsAdmin
          }).catch(() => {});
        } catch (_) {}
      }
    }

    // Anti-group mention
    if (isGroup) {
      try { await handleAntigroupmention(sock, msg, groupMetadata); }
      catch (e) { console.error('[AntiGroupMention]', e); }
    }

    if (isGroup) addMessage(from, sender);

    if (!content || actualMessageTypes.length === 0) return;

    // Button response
    const btn = content.buttonsResponseMessage || msg.message?.buttonsResponseMessage;
    if (btn) {
      const buttonId = btn.selectedButtonId;
      const buildCtx = async () => ({
        from, sender, isGroup, groupMetadata,
        isOwner:    isOwner(sender),
        isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
        isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
        isMod:      isMod(sender),
        reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
        react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
      });
      const cmdName = buttonId === 'btn_menu' ? 'menu' : buttonId === 'btn_ping' ? 'ping' : buttonId === 'btn_help' ? 'list' : null;
      if (cmdName) { const cmd = commands.get(cmdName); if (cmd) await cmd.execute(sock, msg, [], await buildCtx()); return; }
    }

    let body = (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '').trim();

    // ── Middle finger control ─────────────────────────────────────────────────
    if (isGroup && !msg.key.fromMe) {
      try {
        const mfEmojis = ['🖕','🖕🏻','🖕🏼','🖕🏽','🖕🏾','🖕🏿'];
        let hasMF = body ? mfEmojis.some(e => body.includes(e)) : false;
        if (!hasMF && content?.stickerMessage) {
          hasMF = mfEmojis.some(e => (content.stickerMessage.associatedEmoji || '').includes(e));
        }
        if (hasMF) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          const senderIsOwner = isOwner(sender);
          if (!senderIsAdmin && !senderIsOwner) {
            try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
            const mfKey   = `${from}_${sender}`;
            const mfCount = (middleFingerWarnings.get(mfKey) || 0) + 1;
            middleFingerWarnings.set(mfKey, mfCount);
            if (mfCount === 1) {
              await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} This emoji is not allowed here.`, mentions: [sender] }, { quoted: msg });
            } else {
              const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
              if (botIsAdmin) { try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {} }
              middleFingerWarnings.delete(mfKey);
              await sock.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} removed for repeated use of prohibited emoji 🖕`, mentions: [sender] });
              await sock.sendMessage(from, { text: `❌ This emoji is NOT allowed while 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 is active.` });
            }
            return;
          }
        }
      } catch (_) {}
    }

    // ── Auto-mention reply ────────────────────────────────────────────────────
    if (!msg.key.fromMe) {
      try {
        const mentionedJids = content?.extendedTextMessage?.contextInfo?.mentionedJid ||
                              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
                              msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const ownerPhones = getOwnerPhones();
        const ownerMentioned = Array.isArray(mentionedJids) && mentionedJids.some(jid => {
          if (!jid) return false;
          const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          return ownerPhones.includes(num) || getOwnerJids().includes(jid);
        });
        if (ownerMentioned && (Date.now() - ownerLastSeenOnline) >= OWNER_ONLINE_TTL) {
          const replies = ['𝗕𝗢𝗦𝗦 𝗕𝗨𝗦𝗬 𝗛𝗔𝗜𝗡🙁','𝗠𝗥. 𝗠𝗨𝗡𝗘𝗘𝗕 𝗔𝗟𝗜 𝗔𝗕𝗛𝗜 𝗢𝗙𝗙𝗟𝗜𝗡𝗘 𝗛𝗔𝗜𝗡⚡','𝗕𝗢𝗦𝗦 𝗜𝗦 𝗡𝗢𝗧 𝗛𝗘𝗥𝗘 𝗥𝗜𝗚𝗛𝗧 𝗡𝗢𝗪👑','𝗕𝗢𝗦𝗦 𝗞𝗔𝗛𝗜𝗡 𝗕𝗨𝗦𝗬 𝗛𝗔𝗜𝗡⚠️'];
          await sock.sendMessage(from, { text: replies[Math.floor(Math.random() * replies.length)] }, { quoted: msg });
        }
      } catch (_) {}
    }

    // ── Anti-all / anti-tag ───────────────────────────────────────────────────
    if (isGroup) {
      const gs = database.getGroupSettings(from);

      if (gs.antiall) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        if (!senderIsAdmin && !isOwner(sender)) {
          if (await isBotAdmin(sock, from, groupMetadata)) {
            try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
            return;
          }
        }
      }

      if (gs.antitag && !msg.key.fromMe) {
        const ctx           = content.extendedTextMessage?.contextInfo;
        const mentioned     = ctx?.mentionedJid || [];
        const msgText       = body || content.imageMessage?.caption || content.videoMessage?.caption || '';
        const numericM      = msgText.match(/@\d{10,}/g) || [];
        const uniqueNumeric = new Set(numericM.map(m => m.replace('@', '')));
        const total         = Math.max(mentioned.length, uniqueNumeric.size);

        if (total >= 3) {
          try {
            const parts     = groupMetadata.participants || [];
            const threshold = Math.max(3, Math.ceil(parts.length * 0.5));
            const manyNum   = uniqueNumeric.size >= 10 || (uniqueNumeric.size >= 5 && uniqueNumeric.size >= threshold);
            if (total >= threshold || manyNum) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
              if (!senderIsAdmin && !isOwner(sender)) {
                const action     = (gs.antitagAction || 'delete').toLowerCase();
                const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
                try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                if (action === 'kick' && botIsAdmin) {
                  try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
                  try { await sock.sendMessage(from, { text: `🚫 *Antitag!*\n\n@${sender.split('@')[0]} kicked for tagging all.`, mentions: [sender] }, { quoted: msg }); } catch (_) {}
                } else {
                  try { await sock.sendMessage(from, { text: '⚠️ *Tagall Detected!*', mentions: [sender] }, { quoted: msg }); } catch (_) {}
                }
                return;
              }
            }
          } catch (e) { console.error('[AntiTag]', e); }
        }
      }
    }

    // ── AutoSticker ───────────────────────────────────────────────────────────
    if (isGroup) {
      const gs = database.getGroupSettings(from);
      if (gs.autosticker && (content?.imageMessage || content?.videoMessage) && !body.startsWith(config.prefix)) {
        try {
          const cmd = commands.get('sticker');
          if (cmd) {
            await cmd.execute(sock, msg, [], {
              from, sender, isGroup, groupMetadata,
              isOwner:    isOwner(sender),
              isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
              isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
              isMod:      isMod(sender),
              reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
              react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
            });
            return;
          }
        } catch (e) { console.error('[AutoSticker]', e); }
      }
    }

    // ── Active game checks ────────────────────────────────────────────────────
    try {
      const bombModule = getBomb();
      if (bombModule?.gameState?.has(sender)) {
        const cmd = commands.get('bomb');
        if (cmd?.execute) {
          await cmd.execute(sock, msg, [], {
            from, sender, isGroup, groupMetadata,
            isOwner:    isOwner(sender),
            isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod:      isMod(sender),
            reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
            react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          return;
        }
      }
    } catch (_) {}

    try {
      const ttt = getTtt();
      if (ttt?.handleTicTacToeMove) {
        const inGame = Object.values(ttt.games || {}).some(r =>
          r.id.startsWith('tictactoe') && [r.game.playerX, r.game.playerO].includes(sender) && r.state === 'PLAYING'
        );
        if (inGame) {
          const handled = await ttt.handleTicTacToeMove(sock, msg, {
            from, sender, isGroup, groupMetadata,
            isOwner:    isOwner(sender),
            isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod:      isMod(sender),
            reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
            react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handled) return;
        }
      }
    } catch (_) {}

    // ── Non-command branch ────────────────────────────────────────────────────
    if (!body.startsWith(config.prefix)) {
      if (!msg.key.fromMe) {
        try {
          const emojiMap = {
            '🥰': `@${sender.split('@')[0]} Tum emoji pe 3 dil laga ke send karogi tw, itna piyar me kase handle karunga. ❣️`,
            '😂': `@${sender.split('@')[0]} Itna bhi mat hanso ke pet me dard ho jaye, thoda bot pe bhi taras khao! 😜`,
            '❤️': `@${sender.split('@')[0]} Dil de diya hai jaan tumhe denge, par bot ko block mat karna kabhi. ✨`,
            '🔥': `@${sender.split('@')[0]} Itni garmi? Group me aag lagane ka irada hai kya? ⚡`,
            '🤔': `@${sender.split('@')[0]} Itna gehri soch me kyun ho? Bot se hi pooch lo jo poochna hai. 🤖`,
            '😎': `@${sender.split('@')[0]} Swag toh check karo! 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 hai, style toh hoga hi. 👑`,
            '😭': `@${sender.split('@')[0]} Rona band karo, bot abhi zinda hai! Kya hua batao? 🥺`,
            '😡': `@${sender.split('@')[0]} Itna gussa? Thanda paani piyo aur bot se dosti kar lo. 🧊`,
            '🙌': `@${sender.split('@')[0]} Shukriya, shukriya! Itni izzat dene ke liye bohot shukriya. ✨`,
            '✨': `@${sender.split('@')[0]} Chamak toh rahi hai chat, lagta hai koi star aaya hai group me. 🌟`,
          };
          const tb = body.trim();
          if (Object.prototype.hasOwnProperty.call(emojiMap, tb)) {
            await sock.sendMessage(from, { text: emojiMap[tb], mentions: [sender] }, { quoted: msg });
            return;
          }
        } catch (_) {}
      }
      if (isGroup) { try { await handleAntilink(sock, msg, groupMetadata); } catch (e) { console.error('[AntiLink]', e); } }
      try {
        const chatbot = getChatbot();
        if (chatbot?.handleChatbotResponse) await chatbot.handleChatbotResponse(sock, from, msg, body, sender);
      } catch (_) {}
      return;
    }

    // ── Command parsing ───────────────────────────────────────────────────────
    const args        = body.slice(config.prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command     = commands.get(commandName);
    if (!command) return;

    try {
      const bannedUsers = getBannedUsers();
      if (bannedUsers.length > 0) {
        const sp = sender.split('@')[0].split(':')[0];
        if (bannedUsers.some(b => b.split('@')[0].split(':')[0] === sp) && !isOwner(sender)) return;
      }
    } catch (_) {}

    if (config.selfMode && !isOwner(sender)) return;
    if (command.ownerOnly && !isOwner(sender))  return sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    if (command.modOnly && !isMod(sender) && !isOwner(sender)) return sock.sendMessage(from, { text: '🔒 This command is only for moderators!' }, { quoted: msg });
    if (command.groupOnly && !isGroup)  return sock.sendMessage(from, { text: config.messages.groupOnly }, { quoted: msg });
    if (command.privateOnly && isGroup) return sock.sendMessage(from, { text: config.messages.privateOnly }, { quoted: msg });
    if (command.adminOnly && !(await isAdmin(sock, sender, from, groupMetadata)) && !isOwner(sender))
      return sock.sendMessage(from, { text: config.messages.adminOnly }, { quoted: msg });
    if (command.botAdminNeeded && !(await isBotAdmin(sock, from, groupMetadata)))
      return sock.sendMessage(from, { text: config.messages.botAdminNeeded }, { quoted: msg });

    if (config.autoTyping) sock.sendPresenceUpdate('composing', from).catch(() => {});

    const cmdCtx = {
      from, sender, isGroup, groupMetadata,
      isOwner:    isOwner(sender),
      isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
      isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
      isMod:      isMod(sender),
      prefix:     config.prefix,
      downloadMedia: (m, type, opts) => downloadMediaMessage(m || msg, type || 'buffer', opts || {}, { reuploadRequest: sock.updateMediaMessage }),
      reply: (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
    };

    console.log(`[CMD] ${commandName} ← ${sender}`);
    await command.execute(sock, msg, args, cmdCtx);

  } catch (error) {
    console.error('[Handler]', error);
    if (error.message?.includes('rate-overlimit')) return;
    try {
      await sock.sendMessage(msg.key.remoteJid, { text: `${config.messages.error}\n\n${error.message}` }, { quoted: msg });
    } catch (e) { if (!e.message?.includes('rate-overlimit')) console.error('[Handler send-error]', e); }
  }
};

// ── Group participant update handler ──────────────────────────────────────────
const handleGroupUpdate = async (sock, update) => {
  try {
    const { id, participants, action } = update;
    if (!id?.endsWith('@g.us')) return;

    // Invalidate bot-admin cache whenever admin roster changes in this group
    if (action === 'promote' || action === 'demote' || action === 'add' || action === 'remove') {
      invalidateBotAdminCache(id);
    }

    const gs = database.getGroupSettings(id);
    const groupMetadata = await getCachedGroupMetadata(sock, id);
    if (!groupMetadata) return;

    const getJid = (p) => typeof p === 'string' ? p : p?.id || p?.jid || p?.participant || null;

    const getDisplayName = async (pJid, pNum) => {
      let name = pNum;
      const info = groupMetadata.participants.find(p => {
        const pid = p.id || p.jid || p.participant;
        return pid === pJid || pid?.split('@')[0] === pNum;
      });
      let phoneJid = null;
      if (info?.phoneNumber) phoneJid = info.phoneNumber;
      else {
        try {
          const norm = normalizeJidWithLid(pJid);
          if (norm?.includes('@s.whatsapp.net')) phoneJid = norm;
        } catch (_) { if (pJid.includes('@s.whatsapp.net')) phoneJid = pJid; }
      }
      if (phoneJid && sock.store?.contacts?.[phoneJid]) {
        const c = sock.store.contacts[phoneJid];
        if (c.notify?.trim() && !c.notify.match(/^\d+$/)) name = c.notify.trim();
        else if (c.name?.trim() && !c.name.match(/^\d+$/)) name = c.name.trim();
      }
      if (name === pNum && info) {
        if (info.notify?.trim() && !info.notify.match(/^\d+$/)) name = info.notify.trim();
        else if (info.name?.trim() && !info.name.match(/^\d+$/)) name = info.name.trim();
      }
      return name;
    };

    for (const participant of participants) {
      const pJid = getJid(participant);
      if (!pJid) { console.warn('[GroupUpdate] missing JID:', participant); continue; }
      const pNum = pJid.split('@')[0];

      // Bot-screen new joins
      if (action === 'add' && (gs.antibot || gs.antiuserbot) && !isOwnerNumber(pNum)) {
        try {
          const botIsAdmin = await isBotAdmin(sock, id, groupMetadata);
          if (botIsAdmin) {
            let isSuspect = false;
            let suspectReason = '';
            try {
              const status = await sock.fetchStatus(pJid);
              if (BOT_SIGNATURES.some(r => r.test(status?.status || ''))) {
                isSuspect = true; suspectReason = 'Bot signature in WhatsApp status';
              }
            } catch (_) {}
            if (isSuspect) {
              try { await sock.groupParticipantsUpdate(id, [pJid], 'remove'); } catch (_) {}
              try { await sock.sendMessage(id, { text: `🤖 *Bot Removed on Join*\n\n@${pNum} removed.\n📌 ${suspectReason}`, mentions: [pJid] }); } catch (_) {}
              continue;
            }
          }
        } catch (_) {}
      }

      if (action === 'add' && gs.welcome) {
        try {
          const name     = await getDisplayName(pJid, pNum);
          let   picUrl   = 'https://img.pyrocdn.com/dbKUgahg.png';
          try { picUrl = await sock.profilePictureUrl(pJid, 'image'); } catch (_) {}
          const gName    = groupMetadata.subject || 'the group';
          const gDesc    = groupMetadata.desc || 'No description';
          const time     = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const wMsg     = `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${name} 👋\n┃Member count: #${groupMetadata.participants.length}\n┃𝚃𝙸𝙼𝙴: ${time}⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@${name}* Welcome to *${gName}*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${gDesc}\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName}*`;
          const apiUrl   = `https://api.some-random-api.com/welcome/img/7/gaming4?type=join&textcolor=white&username=${encodeURIComponent(name)}&guildName=${encodeURIComponent(gName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(picUrl)}`;

          // PERF #4: Hard 4 s timeout on external image API
          const imgRes = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 4000 });
          await sock.sendMessage(id, { image: Buffer.from(imgRes.data), caption: wMsg, mentions: [pJid] });
        } catch (_) {
          const fallback = (gs.welcomeMessage || 'Welcome @user to @group! 👋')
            .replace('@user', `@${pNum}`).replace('@group', groupMetadata.subject || 'the group');
          try { await sock.sendMessage(id, { text: fallback, mentions: [pJid] }); } catch (_) {}
        }

      } else if (action === 'remove') {

        // ── Auto Re-Add ────────────────────────────────────────────────────────
        console.log(`[RE-ADD] remove event — group=${id.split('@')[0]} user=${pNum} readd=${gs.readd}`);
        if (gs.readd) {
          // ① Anti-loop guard: skip if this exact user was processed < 60 s ago
          const loopKey = `${id}:${pJid}`;
          const nowMs   = Date.now();
          if (reAddCooldown.has(loopKey) && nowMs - reAddCooldown.get(loopKey) < 60_000) {
            console.log(`[RE-ADD] Cooldown active for ${pNum} in ${id} — skipping`);
          } else {
            reAddCooldown.set(loopKey, nowMs);

            // Prune stale entries (older than 2 min) so the Map never grows unbounded
            if (reAddCooldown.size > 300) {
              const cutoff = nowMs - 120_000;
              for (const [k, t] of reAddCooldown.entries()) {
                if (t < cutoff) reAddCooldown.delete(k);
              }
            }

            // ② Bot must be admin to re-add anyone
            const botCanAdd = await isBotAdmin(sock, id, groupMetadata);
            if (!botCanAdd) {
              console.log(`[RE-ADD] Bot is not admin in ${id} — skipping`);
            } else {
              // ③ Wait 2–3 seconds (random) before re-adding
              await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));

              let reAddSuccess = false;
              try {
                const result = await sock.groupParticipantsUpdate(id, [pJid], 'add');
                // Baileys returns an array of { status, jid } — 200 means success
                reAddSuccess = Array.isArray(result) &&
                  result.some(r => String(r.status) === '200');
              } catch (_) {
                reAddSuccess = false;
              }

              if (reAddSuccess) {
                // ✅ SUCCESS — exact message as specified (do NOT change)
                try {
                  await sock.sendMessage(id, {
                    text:
                      `Bhagne Ke Liye Nahi Bola @${pNum} 😛 ,🥀𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 🌴 Ke 𝐏𝐞𝐫𝐦𝐢𝐬𝐬𝐢𝐨𝐧 Bagair Tum Kahin Nahi Ja Sakte 😄\n` +
                      `Dekho Maine Tumhe Phir C Add Kar Diya Hai 😄\n` +
                      `Baby meRe Hote Hue Tum Bagh Nahi Sakte 😂🤣`,
                    mentions: [pJid]
                  });
                } catch (_) {}
              } else {
                // ❌ FAIL — exact message as specified (do NOT change)
                try {
                  await sock.sendMessage(id, {
                    text:
                      `😏 @${pNum} bhaagne ki koshish to ki…\n` +
                      `Lekin system ne allow nahi kiya 😅\n` +
                      `Lagta hai tumhari privacy settings strong hain ya WhatsApp ne rok diya 😂\n` +
                      `Phir bhi yaad rakhna… yahan se bhaagna itna aasaan nahi 😛`,
                    mentions: [pJid]
                  });
                } catch (_) {}
              }
            }
          }
        } else if (gs.goodbye) {
          // ── Goodbye message (only when readd is OFF) ─────────────────────────
          try {
            const name   = await getDisplayName(pJid, pNum);
            let   picUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
            try { picUrl = await sock.profilePictureUrl(pJid, 'image'); } catch (_) {}
            const gName  = groupMetadata.subject || 'the group';
            const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=leave&textcolor=white&username=${encodeURIComponent(name)}&guildName=${encodeURIComponent(gName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(picUrl)}`;
            const imgRes = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 4000 });
            await sock.sendMessage(id, { image: Buffer.from(imgRes.data), caption: `Goodbye @${name} 👋 We will never miss you!`, mentions: [pJid] });
          } catch (_) {
            try { await sock.sendMessage(id, { text: `Goodbye @${pNum} 👋 We will never miss you! 💀`, mentions: [pJid] }); } catch (_) {}
          }
        }
      }
    }
  } catch (error) {
    const is403 = error.message?.includes('forbidden') || error.message?.includes('403') || error.statusCode === 403 || error.data === 403;
    if (!is403) console.error('[GroupUpdate]', error);
  }
};

// ── Anti-link ─────────────────────────────────────────────────────────────────
const handleAntilink = async (sock, msg, groupMetadata) => {
  try {
    const from   = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const gs     = database.getGroupSettings(from);
    if (!gs.antilink) return;

    const body = [msg.message?.conversation, msg.message?.extendedTextMessage?.text,
      msg.message?.imageMessage?.caption, msg.message?.videoMessage?.caption, msg.message?.documentMessage?.caption,
      msg.message?.ephemeralMessage?.message?.conversation, msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text,
    ].filter(Boolean).join(' ').trim();

    if (!body) return;
    if (!/chat\.whatsapp\.com\/[A-Za-z0-9]{5,}/i.test(body) && !/https?:\/\/[^\s]{4,}/i.test(body)) return;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    if (senderIsAdmin || isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0])) return;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
    if (botIsAdmin) { try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {} }
    try {
      await sock.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} removed! Links are NOT allowed.`, mentions: [sender] });
      await sock.sendMessage(from, { text: `⚠️ Group Notice: Sending links is strictly prohibited here.` });
    } catch (_) {}
  } catch (e) { console.error('[AntiLink]', e); }
};

// ── Anti-group mention ────────────────────────────────────────────────────────
const handleAntigroupmention = async (sock, msg, groupMetadata) => {
  try {
    const from   = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const gs     = database.getGroupSettings(from);
    if (!gs.antigroupmention) return;

    let isForwarded = false;
    if (msg.message) {
      const m = msg.message;
      isForwarded = !!(m.groupStatusMentionMessage ||
        (m.protocolMessage?.type === 25) ||
        m.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.imageMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.videoMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.contextInfo?.forwardedNewsletterMessageInfo ||
        m.contextInfo?.isForwarded || m.contextInfo?.forwardingScore || m.contextInfo?.quotedMessageTimestamp ||
        m.extendedTextMessage?.contextInfo?.isForwarded || m.extendedTextMessage?.contextInfo?.forwardingScore);
    }
    if (!isForwarded) return;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    if (senderIsAdmin || isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0])) return;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    const action     = (gs.antigroupmentionAction || 'delete').toLowerCase();

    if (action === 'kick' && botIsAdmin) {
      try { await sock.sendMessage(from, { delete: msg.key }); await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
    } else {
      try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
    }
  } catch (e) { console.error('[AntiGroupMention]', e); }
};

// ── Owner presence tracker ────────────────────────────────────────────────────
const initializeOwnerPresenceTracker = async (sock) => {
  for (const jid of getOwnerJids()) { try { await sock.presenceSubscribe(jid); } catch (_) {} }
  sock.ev.on('presence.update', ({ presences }) => {
    try {
      if (!presences) return;
      const phones = getOwnerPhones();
      for (const [jid, presence] of Object.entries(presences)) {
        const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (!phones.includes(num)) continue;
        const s = presence.lastKnownPresence;
        if (s === 'available' || s === 'composing' || s === 'recording') ownerLastSeenOnline = Date.now();
      }
    } catch (_) {}
  });
};

// ── Anti-call ─────────────────────────────────────────────────────────────────
// Runtime flag — can be toggled without restarting the bot.
// Default: read from config.js; the .anticall on/off command updates this live.
let _antiCallEnabled = !!(config.anticall);

const setAntiCall = (val) => {
  _antiCallEnabled = !!val;
  console.log(`[ANTICALL] ${_antiCallEnabled ? '✅ Enabled' : '❌ Disabled'} at runtime`);
};

const initializeAntiCall = (sock) => {
  sock.ev.on('call', async (calls) => {
    // Check live runtime flag — updated instantly by .anticall on/off command
    if (!_antiCallEnabled) return;
    try {
      for (const call of calls) {
        if (call.status === 'offer') {
          try { await sock.rejectCall(call.id, call.from); } catch (_) {}
          try {
            await sock.sendMessage(call.from, {
              text: '📵 *Calls are not allowed on this bot.*\n\nPlease use text commands instead.'
            });
          } catch (_) {}
        }
      }
    } catch (e) { console.error('[ANTICALL]', e); }
  });
};

// ── Queued entry point ────────────────────────────────────────────────────────
const handleMessageQueued = (sock, msg) =>
  runWithQueue(() => handleMessage(sock, msg));

module.exports = {
  handleMessage: handleMessageQueued,
  handleGroupUpdate,
  handleAntilink,
  handleAntigroupmention,
  initializeAntiCall,
  setAntiCall,
  initializeOwnerPresenceTracker,
  // HARD-LOCKED: only 923329838699 is the owner — sessionConfig is intentionally ignored
  isOwner: (sender) => isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0]),
  isAdmin,
  isBotAdmin,
  isMod,
  getGroupMetadata,
  findParticipant
};
