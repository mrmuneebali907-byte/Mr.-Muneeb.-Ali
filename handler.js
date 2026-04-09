/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const { loadCommands } = require('./utils/commandLoader');
const { addMessage } = require('./utils/groupstats');
const { jidDecode, jidEncode, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const linkWarnings = new Map();
const path = require('path');
const axios = require('axios');

// ── Concurrency limiter for heavy-load handling ───────────────────────────────
// Prevents memory spikes when many users send commands simultaneously.
const MAX_CONCURRENT = 20; // max simultaneous message handlers
let activeHandlers = 0;
const pendingQueue = [];

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
          if (pendingQueue.length > 0) {
            const next = pendingQueue.shift();
            next();
          }
        });
    };
    if (activeHandlers < MAX_CONCURRENT) {
      task();
    } else {
      // Drop oldest if queue is very large (prevents memory blowup)
      if (pendingQueue.length > 200) pendingQueue.shift();
      pendingQueue.push(task);
    }
  });
}

// Group metadata cache to prevent rate limiting
const groupMetadataCache = new Map();
const CACHE_TTL     = 60000; // 1 minute cache
const MAX_CACHE_SZ  = 500;   // max groups cached
const MAX_WARN_SZ   = 1000;  // max link-warning entries

// ── Periodic cache housekeeping (runs every 10 minutes) ──────────────────────
setInterval(() => {
  try {
    const now = Date.now();

    // Evict expired group metadata entries
    for (const [key, val] of groupMetadataCache.entries()) {
      if (now - val.timestamp > CACHE_TTL * 5) groupMetadataCache.delete(key);
    }
    // Hard cap — remove oldest if still oversized
    if (groupMetadataCache.size > MAX_CACHE_SZ) {
      const overflow = groupMetadataCache.size - MAX_CACHE_SZ;
      let removed = 0;
      for (const key of groupMetadataCache.keys()) {
        if (removed >= overflow) break;
        groupMetadataCache.delete(key);
        removed++;
      }
    }

    // Hard cap linkWarnings map
    if (linkWarnings.size > MAX_WARN_SZ) {
      let removed = 0;
      const overflow = linkWarnings.size - MAX_WARN_SZ;
      for (const key of linkWarnings.keys()) {
        if (removed >= overflow) break;
        linkWarnings.delete(key);
        removed++;
      }
    }
  } catch (_) {}
}, 10 * 60 * 1000).unref();

// Load all commands
const commands = loadCommands();

// Unwrap WhatsApp containers (ephemeral, view once, etc.)
const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;
  
  let m = msg.message;
  
  // Common wrappers in modern WhatsApp
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  
  // You can add more wrappers if needed later
  return m;
};

// Cached group metadata getter with rate limit handling (for non-admin checks)
const getCachedGroupMetadata = async (sock, groupId) => {
  try {
    // Validate group JID before attempting to fetch
    if (!groupId || !groupId.endsWith('@g.us')) {
      return null;
    }
    
    // Check cache first
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data; // Return cached data (even if null for forbidden groups)
    }
    
    // Fetch from API
    const metadata = await sock.groupMetadata(groupId);
    
    // Cache it
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // Handle forbidden (403) errors - cache null to prevent retry storms
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Cache null for forbidden groups to prevent repeated attempts
      groupMetadataCache.set(groupId, {
        data: null,
        timestamp: Date.now()
      });
      return null; // Silently return null for forbidden groups
    }
    
    // Handle rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      const cached = groupMetadataCache.get(groupId);
      if (cached) {
        return cached.data;
      }
      return null;
    }
    
    // For other errors, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    
    // Return null instead of throwing to prevent crashes
    return null;
  }
};

// Live group metadata getter (always fresh, no cache) - for admin checks
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    // Always fetch fresh metadata, bypass cache
    const metadata = await sock.groupMetadata(groupId);
    
    // Update cache for other features (antilink, welcome, etc.)
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // On error, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    return null;
  }
};

// Alias for backward compatibility (non-admin features use cached)
const getGroupMetadata = getCachedGroupMetadata;

// Helper functions
const { isOwner: _isOwnerUtil, isOwnerFromMsg: _isOwnerFromMsgUtil } = require('./utils/ownerUtils');
const isOwner = (sender, sessionConfig) => _isOwnerUtil(sender, sessionConfig);

const isMod = (sender) => {
  const number = sender.split('@')[0];
  return database.isModerator(number);
};

// LID mapping cache
const lidMappingCache = new Map();

// Helper to normalize JID to just the number part
const normalizeJid = (jid) => {
  if (!jid) return null;
  if (typeof jid !== 'string') return null;
  
  // Remove device ID if present (e.g., "1234567890:0@s.whatsapp.net" -> "1234567890")
  if (jid.includes(':')) {
    return jid.split(':')[0];
  }
  // Remove domain if present (e.g., "1234567890@s.whatsapp.net" -> "1234567890")
  if (jid.includes('@')) {
    return jid.split('@')[0];
  }
  return jid;
};

// Get LID mapping value from session files — scans ALL session directories
const getLidMappingValue = (user, direction) => {
  if (!user) return null;

  const cacheKey = `${direction}:${user}`;
  if (lidMappingCache.has(cacheKey)) {
    return lidMappingCache.get(cacheKey);
  }

  const suffix   = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filename = `lid-mapping-${user}${suffix}`;

  // Build ordered list of directories to search
  const searchDirs = [];

  // 1. All session_N subdirectories (multi-session setup)
  const sessionsBase = path.join(__dirname, 'sessions');
  try {
    if (fs.existsSync(sessionsBase)) {
      for (const entry of fs.readdirSync(sessionsBase)) {
        if (entry.startsWith('session_')) {
          searchDirs.push(path.join(sessionsBase, entry));
        }
      }
    }
  } catch (_) {}

  // 2. Legacy single-session fallback
  searchDirs.push(path.join(__dirname, config.sessionName || 'session'));

  for (const dir of searchDirs) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw   = fs.readFileSync(filePath, 'utf8').trim();
      const value = raw ? JSON.parse(raw) : null;
      if (value !== null && value !== undefined) {
        lidMappingCache.set(cacheKey, value);
        return value;
      }
    } catch (_) {}
  }

  lidMappingCache.set(cacheKey, null);
  return null;
};

// Normalize JID handling LID conversion
const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    }
    
    let user = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) {
        user = pnUser;
        server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        return true;
      }
      return false;
    };
    
    if (server === 'lid' || server === 'hosted.lid') {
      mapToPn();
    } else if (server === 's.whatsapp.net' || server === 'hosted') {
      mapToPn();
    }
    
    if (server === 'hosted') {
      return jidEncode(user, 'hosted');
    }
    return jidEncode(user, 's.whatsapp.net');
  } catch (error) {
    return jid;
  }
};

// Build comparable JID variants (PN + LID) for matching
const buildComparableIds = (jid) => {
  if (!jid) return [];
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return [normalizeJidWithLid(jid)].filter(Boolean);
    }
    
    const variants = new Set();
    const normalizedServer = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    variants.add(jidEncode(decoded.user, normalizedServer));
    
    const isPnServer = normalizedServer === 's.whatsapp.net' || normalizedServer === 'hosted';
    const isLidServer = normalizedServer === 'lid' || normalizedServer === 'hosted.lid';
    
    if (isPnServer) {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) {
        const lidServer = normalizedServer === 'hosted' ? 'hosted.lid' : 'lid';
        variants.add(jidEncode(lidUser, lidServer));
      }
    } else if (isLidServer) {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) {
        const pnServer = normalizedServer === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        variants.add(jidEncode(pnUser, pnServer));
      }
    }
    
    return Array.from(variants);
  } catch (error) {
    return [jid];
  }
};

// Find participant by either PN JID or LID JID
const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));
  
  if (!targets.length) return null;
  
  return participants.find(participant => {
    if (!participant) return false;
    
    const participantIds = [
      participant.id,
      participant.lid,
      participant.userJid
    ]
      .filter(Boolean)
      .flatMap(id => buildComparableIds(id));
    
    return participantIds.some(id => targets.includes(id));
  }) || null;
};

const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant) return false;

  // Early return for non-group JIDs (DMs)
  if (!groupId || !groupId.endsWith('@g.us')) return false;

  // Always fetch live metadata for admin checks
  let liveMetadata = groupMetadata;
  if (!liveMetadata || !liveMetadata.participants) {
    liveMetadata = await getLiveGroupMetadata(sock, groupId);
  }

  if (!liveMetadata || !liveMetadata.participants) return false;

  const participants = liveMetadata.participants;

  // ── Strategy 1: Full LID-aware matching via findParticipant ─────────────────
  const found = findParticipant(participants, participant);
  if (found) {
    return found.admin === 'admin' || found.admin === 'superadmin';
  }

  // ── Strategy 2: Raw phone-number comparison (strips server/LID suffix) ───────
  // Handles cases where LID mapping files are missing or incomplete.
  // e.g. sender = "22858419949667@lid", participant.id = "923329838699@s.whatsapp.net"
  // We resolve sender LID → phone via mapping files and compare numerically.
  const senderUser = participant.split('@')[0].split(':')[0];

  // Try to resolve LID → phone
  let senderPhone = senderUser;
  if (participant.includes('@lid') || participant.includes('@hosted.lid')) {
    const resolved = getLidMappingValue(senderUser, 'lidToPn');
    if (resolved) senderPhone = String(resolved);
  }

  const fallback = participants.find(p => {
    const pid = (p.id || '').split('@')[0].split(':')[0];
    if (!pid) return false;
    // Direct match (both phone numbers or both LIDs)
    if (pid === senderPhone || pid === senderUser) return true;
    // Reverse: participant might be a LID, resolve it too
    if ((p.id || '').includes('@lid')) {
      const resolvedPid = getLidMappingValue(pid, 'lidToPn');
      if (resolvedPid && String(resolvedPid) === senderPhone) return true;
    }
    return false;
  });

  if (fallback) {
    return fallback.admin === 'admin' || fallback.admin === 'superadmin';
  }

  return false;
};

const isBotAdmin = async (sock, groupId, groupMetadata = null) => {
  if (!sock.user || !groupId) return false;
  
  // Early return for non-group JIDs (DMs)
  if (!groupId.endsWith('@g.us')) return false;
  
  try {
    const botRawId = sock.user.id;            // may be '923...:12@s.whatsapp.net'
    const botLid   = sock.user.lid;           // LID variant if present

    if (!botRawId) return false;

    // Strip device suffix (`:12`) so it matches participant list format
    const botPnId = botRawId.split(':')[0].split('@')[0] + '@s.whatsapp.net';

    // Collect all ID variants to check against
    const botJids = [botRawId, botPnId];
    if (botLid) botJids.push(botLid);

    // ALWAYS fetch live metadata for bot admin checks (never use cached)
    const liveMetadata = await getLiveGroupMetadata(sock, groupId);
    if (!liveMetadata || !liveMetadata.participants) return false;

    // First try findParticipant (handles LID cross-matching)
    const participant = findParticipant(liveMetadata.participants, botJids);
    if (participant) {
      return participant.admin === 'admin' || participant.admin === 'superadmin';
    }

    // Fallback: direct string comparison as last resort
    const directMatch = liveMetadata.participants.find(p => {
      const pid = (p.id || '').split(':')[0].split('@')[0];
      return botJids.some(jid => jid.split(':')[0].split('@')[0] === pid);
    });
    if (directMatch) {
      return directMatch.admin === 'admin' || directMatch.admin === 'superadmin';
    }

    return false;
  } catch {
    return false;
  }
};

const isUrl = (text) => {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  return urlRegex.test(text);
};

const hasGroupLink = (text) => {
  const linkRegex = /chat.whatsapp.com\/([0-9A-Za-z]{20,24})/i;
  return linkRegex.test(text);
};

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || 
         jid.includes('status.broadcast') || 
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Main message handler
const handleMessage = async (sock, msg, sessionConfig) => {
  // Use session-specific config if provided (for per-session owner number), else global config
  const effectiveConfig = sessionConfig || config;
  try {
    // ── Owner check: bulletproof, LID-aware — via centralized ownerUtils ──────
    const isOwner = (sender) => _isOwnerUtil(sender, effectiveConfig);

    // Debug logging to see all messages
    // Debug log removed
    
    if (!msg.message) return;
    
    const from = msg.key.remoteJid;
    
    // System message filter - ignore broadcast/status/newsletter messages
    if (isSystemJid(from)) {
      return; // Silently ignore system messages
    }
    
    // Auto-React System
    try {
      // Read auto-react state via utility (keeps in sync with .autoreact command)
      const { load: loadAutoReact } = require('./utils/autoReact');
      const arCfg = loadAutoReact();

      if (arCfg.enabled && msg.message && !msg.key.fromMe) {
        const content = msg.message.ephemeralMessage?.message || msg.message;
        const text =
          content.conversation ||
          content.extendedTextMessage?.text ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          content.documentMessage?.caption ||
          '';

        const jid = msg.key.remoteJid;

        const emojis = [
          '❤️','🖤','🤍','💛','💚','💙','💜','🧡','❤️‍🔥','💗','💓','💞','💘','💝',
          '🔥','⚡','💥','🌪️','☄️','🌋','💫','✨','🌟','⭐','🌠',
          '💀','🦅','🦁','🐺','🦍','🦂','🐍','🦇','🐉','🦊','🐯',
          '💎','👑','🏆','🥇','🎖️','💸','💰','💳','💍','🥂','🍾','🎯',
          '⚔️','🗡️','🏹','🛡️','🔱','⚜️','🪃','🔫','💣','🧨','🥊','🥋',
          '🔮','🧿','♟️','🎭','⛓️','🕯️','🗝️','📜','🗺️','🕹️','💻','📡',
          '🪐','🌑','🌌','🚀','🛸','🌒','🌓','🌔','🌕',
          '🎱','💿','🎸','🎺','🏴‍☠️','🎪','🎠','🎡','🎢',
          '🦈','🐋','🐆','🐅','🦃','🦚','🦜','🦉',
          '🩸','👺','👹','🤺','🧛','🧟','🕷️','🦾','🤖','👾',
          '👌','🤝','🫡','🤜','🤛','✌️','🤟','👊','🫶',
          '😎','🥶','🥵','😈','👿','🤬','😤','🤯','😏',
        ];

        const mode       = arCfg.mode || 'all';
        const rand       = emojis[Math.floor(Math.random() * emojis.length)];
        const prefixList = ['.', '/', '!', '#'];
        const isCommand  = prefixList.includes(text?.trim()?.[0]);

        if (mode === 'bot') {
          // In bot mode: ⏳ for commands (processing indicator), random emoji for all other msgs
          const reactEmoji = isCommand ? '⏳' : rand;
          await sock.sendMessage(jid, { react: { text: reactEmoji, key: msg.key } });
        } else {
          // In 'all' mode: random emoji for every message
          await sock.sendMessage(jid, { react: { text: rand, key: msg.key } });
        }
      }
    } catch (_) {
      // Auto-react errors must never interrupt message processing
    }
    
    // Unwrap containers first
    const content = getMessageContent(msg);
    // Note: We don't return early if content is null because forwarded status messages might not have content
    
    // Still check for actual message content for regular processing
    let actualMessageTypes = [];
    if (content) {
      const allKeys = Object.keys(content);
      // Filter out protocol/system messages and find actual message content
      const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = allKeys.filter(key => !protocolMessages.includes(key));
    }
    
    // We'll check for empty content later after we've processed group messages
    
    // Use the first actual message type (conversation, extendedTextMessage, etc.)
    const messageType = actualMessageTypes[0];
    
    // from already defined above in DM block check
    const sender = msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us'); // Should always be true now due to DM block above
    
    // Fetch group metadata immediately if it's a group
    const groupMetadata = isGroup ? await getGroupMetadata(sock, from) : null;
  // ================== 🛡️ NSFW CONTENT FILTER ==================
  try {
    // Only run NSFW filter in groups where it's explicitly enabled
    if (isGroup && groupMetadata) {
      const groupSettings = database.getGroupSettings(from);

      if (groupSettings.nsfw) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        const senderIsOwner = isOwner(sender);

        // Skip admins and owner — they are trusted
        if (!senderIsAdmin && !senderIsOwner) {
          const messageContent = msg.message?.ephemeralMessage?.message
            || msg.message?.viewOnceMessage?.message
            || msg.message;

          const mediaType = Object.keys(messageContent || {})[0];
          const mediaTypes = ['imageMessage', 'videoMessage', 'stickerMessage'];

          // ── Check plain text messages for adult words/links ──────────
          const msgText = (
            messageContent?.conversation ||
            messageContent?.extendedTextMessage?.text ||
            ''
          ).toLowerCase();

          const adultLinks = [
            'xnxx.com', 'xvideos.com', 'pornhub.com', 'xhamster.com',
            'redtube.com', 'youporn.com', 'brazzers.com', 'onlyfans.com',
            'fapello.com', 'thothub.tv', 'nudostar.com', 'nudogram.com'
          ];

          const adultWords = [
            // English explicit (user-requested additions first)
            'xxx', 'porn', 'nude', 'naked', 'adult', '18+', 'explicit',
            'erotic', 'hot video', 'dirty', 'nsfw', 'leaked', 'private video',
            'rule34', 'xnxx', 'xvideos', 'pornhub', 'onlyfans', 'lewd',
            'hentai', 'bdsm', 'fetish',
            // Body / acts
            'pussy', 'vagina', 'penis', 'cock', 'dick', 'boobs', 'tits',
            'nipple', 'ass naked', 'fuck girl', 'sex video', 'sex clip',
            'sex tape', 'nude video', 'nude photo', 'nude pic',
            'strip tease', 'blowjob', 'handjob', 'masturbat', 'orgasm',
            // Soft variants / typos that slip through
            'sexi', 'sexxy', 'hardco', 'softco', 'camgirl',
            'onlyfan', 'sexting', 'nudes', 'titties', 'booty naked',
            // Adult site names
            'xhamster', 'redtube', 'youporn', 'brazzers', 'bangbros',
            'realitykings', 'mofos', 'teamskeet', 'naughtyamerica',
            'chaturbate', 'livejasmin', 'stripchat', 'cam4',
            // Urdu / Hindi
            'lund', 'choot', 'gaand', 'nangi', 'chudai', 'randi',
            'sexy video', 'bf video', 'blue film', 'gandi video',
            // Arabic
            'كس', 'زب', 'بزاز', 'سكس', 'نيك', 'عاهرة', 'إباحي'
          ];

          const isAdultLink = adultLinks.some(l => msgText.includes(l));
          const isAdultText = adultWords.some(w => msgText.includes(w));

          if ((isAdultLink || isAdultText) && (mediaType === 'conversation' || mediaType === 'extendedTextMessage')) {
            // Delete the adult text/link
            try {
              await sock.sendMessage(from, {
                delete: { remoteJid: from, fromMe: false, id: msg.key.id, participant: msg.key.participant || sender }
              });
            } catch {}

            const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
            const warningData = database.addWarning(from, sender, isAdultLink ? 'Adult link shared' : 'Adult text detected');
            const warningCount = warningData.count;
            const maxWarnings = config.maxWarnings || 3;

            if (warningCount >= maxWarnings && botIsAdmin) {
              try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch {}
              database.clearWarnings(from, sender);
              await sock.sendMessage(from, {
                text: `🚫 @${sender.split('@')[0]} removed after ${maxWarnings} NSFW warnings!`,
                mentions: [sender]
              });
            } else {
              await sock.sendMessage(from, {
                text: `⚠️ @${sender.split('@')[0]} — *${isAdultLink ? 'Adult link' : 'Adult content'} detected and deleted!*\n\n📊 Warning ${warningCount}/${maxWarnings}${warningCount >= maxWarnings - 1 ? '\n🔴 Next violation = removal!' : ''}`,
                mentions: [sender]
              });
            }
          }

          if (mediaTypes.includes(mediaType)) {
            let isBad = false;
            let badReason = 'NSFW media';

            // ── Step 1: Caption / sticker keyword check (instant, no API) ──
            const captionText = (
              messageContent?.imageMessage?.caption ||
              messageContent?.videoMessage?.caption ||
              ''
            ).toLowerCase();

            const captionBadWords = [
              'xxx', 'porn', 'sex', 'nude', 'naked', 'xnxx', 'xvideos',
              'pornhub', 'xhamster', 'redtube', 'adult', '18+', 'nsfw',
              'onlyfans', 'lewd', 'hentai', 'bdsm', 'fetish'
            ];

            if (captionBadWords.some(w => captionText.includes(w))) {
              isBad = true;
              badReason = 'NSFW caption detected';
            }

            // ── Step 2: Visual AI scan (multiple APIs with fallbacks) ───────
            if (!isBad) {
              try {
                // Download the media using the correct Baileys API
                const mediaBuffer = await downloadMediaMessage(
                  msg,
                  'buffer',
                  {},
                  { reuploadRequest: sock.updateMediaMessage }
                );

                if (mediaBuffer && mediaBuffer.length > 5000) {
                  const FormData = require('form-data');
                  let nsfwScore = 0;
                  let detectionDone = false;

                  // Detection API 1: Sightengine (free demo)
                  if (!detectionDone) {
                    try {
                      const fd1 = new FormData();
                      fd1.append('media', mediaBuffer, { filename: 'img.jpg', contentType: 'image/jpeg' });
                      fd1.append('models', 'nudity-2.0');
                      fd1.append('api_user', '1096098116');
                      fd1.append('api_secret', 'demo');
                      const r1 = await axios.post('https://api.sightengine.com/1.0/check.json', fd1, {
                        headers: fd1.getHeaders(), timeout: 12000
                      });
                      const nudity = r1.data?.nudity;
                      if (nudity) {
                        nsfwScore = Math.max(
                          nudity.raw || 0,
                          nudity.partial || 0,
                          nudity.sexual_activity || 0,
                          nudity.sexual_display || 0
                        );
                        detectionDone = true;
                        if (nsfwScore > 0.65) { isBad = true; badReason = 'NSFW image/video'; }
                      }
                    } catch {}
                  }

                  // Detection API 2: DeepAI free tier
                  if (!detectionDone) {
                    try {
                      const fd2 = new FormData();
                      fd2.append('image', mediaBuffer, { filename: 'img.jpg', contentType: 'image/jpeg' });
                      const r2 = await axios.post('https://api.deepai.org/api/nsfw-detector', fd2, {
                        headers: { ...fd2.getHeaders(), 'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K' },
                        timeout: 12000
                      });
                      const score = r2.data?.output?.nsfw_score;
                      if (typeof score === 'number') {
                        detectionDone = true;
                        if (score > 0.70) { isBad = true; badReason = 'NSFW image/video'; }
                      }
                    } catch {}
                  }

                  // Detection API 3: moderatecontent.com (free)
                  if (!detectionDone) {
                    try {
                      const fd3 = new FormData();
                      fd3.append('image', mediaBuffer, { filename: 'img.jpg', contentType: 'image/jpeg' });
                      const r3 = await axios.post('https://api.moderatecontent.com/moderate/', fd3, {
                        headers: fd3.getHeaders(), timeout: 12000
                      });
                      const rating = r3.data?.rating_label;
                      if (rating === 'adult' || rating === 'racy') {
                        isBad = true;
                        badReason = 'NSFW image/video';
                        detectionDone = true;
                      }
                    } catch {}
                  }

                  // Detection API 4: PicPurify (free tier)
                  if (!detectionDone) {
                    try {
                      const fd4 = new FormData();
                      fd4.append('image', mediaBuffer, { filename: 'img.jpg', contentType: 'image/jpeg' });
                      fd4.append('task', 'porn_detection');
                      const r4 = await axios.post('https://www.picpurify.com/analyse/1.1', fd4, {
                        headers: fd4.getHeaders(), timeout: 12000
                      });
                      if (r4.data?.porn_detection_result === 'KO') {
                        isBad = true;
                        badReason = 'NSFW image/video';
                      }
                    } catch {}
                  }
                }
              } catch {
                // Media download failed — do not penalize (could be a voice note, doc, etc.)
              }
            }

            // ── Step 3: Enforcement — warn → kick ─────────────────────────
            if (isBad) {
              // Instantly delete the NSFW message
              try {
                await sock.sendMessage(from, {
                  delete: {
                    remoteJid: from,
                    fromMe: false,
                    id: msg.key.id,
                    participant: msg.key.participant || sender
                  }
                });
              } catch {}

              const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
              const warningData = database.addWarning(from, sender, badReason);
              const warningCount = warningData.count;
              const maxWarnings = config.maxWarnings || 3;
              const remaining = maxWarnings - warningCount;

              if (warningCount >= maxWarnings && botIsAdmin) {
                // Kick the user
                try {
                  await sock.groupParticipantsUpdate(from, [sender], 'remove');
                } catch {}
                database.clearWarnings(from, sender);
                await sock.sendMessage(from, {
                  text:
                    `🚫 *User Removed*\n\n` +
                    `@${sender.split('@')[0]} has been removed from this group.\n\n` +
                    `📌 Reason: ${badReason}\n` +
                    `📊 Total warnings: ${maxWarnings}/${maxWarnings}`,
                  mentions: [sender]
                });
              } else {
                const progressBar = '🔴'.repeat(warningCount) + '⚪'.repeat(maxWarnings - warningCount);
                await sock.sendMessage(from, {
                  text:
                    `⚠️ *NSFW Content Detected*\n\n` +
                    `@${sender.split('@')[0]} — Your message was deleted.\n\n` +
                    `📌 Reason: ${badReason}\n` +
                    `📊 Warnings: ${progressBar} (${warningCount}/${maxWarnings})\n\n` +
                    (remaining <= 1
                      ? `🔴 *Final warning! Next violation = removal!*`
                      : `⚠️ ${remaining} more violation${remaining > 1 ? 's' : ''} before removal.`),
                  mentions: [sender]
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[NSFW Filter] Error:', err.message);
  }
  // ================== 🛡️ END NSFW FILTER ==================

  // ================== 🤖 SELF-BOT / USER-BOT DETECTOR ==================
  try {
    if (isGroup && groupMetadata) {
      const groupSettings = database.getGroupSettings(from);

      if (groupSettings.antiuserbot) {
        const senderIsAdmin  = await isAdmin(sock, sender, from, groupMetadata);
        const senderIsOwner  = isOwner(sender);
        const botIsAdmin     = await isBotAdmin(sock, from, groupMetadata);

        if (!senderIsAdmin && !senderIsOwner && botIsAdmin) {
          const rawContent = msg.message?.ephemeralMessage?.message || msg.message || {};
          const textBody   = (
            rawContent?.conversation ||
            rawContent?.extendedTextMessage?.text ||
            rawContent?.imageMessage?.caption ||
            rawContent?.videoMessage?.caption ||
            ''
          );

          // ── Common automated-bot footer / signature patterns ──────────
          const botSignatures = [
            // Xeon Bot family
            /powered\s+by\s+xeon/i, /xeon\s*bot/i,
            // Cheems-Bot / MD-Bot footers
            /cheems[\s\-_]*bot/i, /ᴄʜᴇᴇᴍs/i,
            // Mr-Perfect / similar
            /mr[\.\s\-]*perfect\s*bot/i,
            // ZairaBOT, ZairaMD, etc.
            /zaira[\s\-_]*(bot|md)/i,
            // WhatsApp Bot MD generic footer
            /whatsapp\s*bot\s*md/i,
            // "Bot Prefix" auto-footer (common in open-source bots)
            /bot\s*made\s*by/i,
            // Wamellow, Sticker Maker bots
            /wamellow/i, /stickermaker/i,
            // MIKI-BOT, PIKA-BOT, etc.
            /\b(miki|pika|kitsune|rose|rika)\s*bot\b/i,
            // Common open-source WA bot repos
            /baileys[\s\-]*bot/i, /baileys[\s\-]*md/i,
            // "Sent via <BotName>" pattern
            /sent\s+via\s+\w+\s*bot/i,
            // Footer dividers common in user-bots: ─────
            /^[─━═]{5,}$/m,
            // "© BotName" copyright footer
            /©\s*\w+\s*bot/i,
            // Automated-reply disclaimer
            /this\s+(is\s+an?\s+)?(automated|auto)\s+(reply|message|response)/i
          ];

          // ── Bot-like prefix / command pattern in normal messages ──────
          // User-bots often trigger other bots with common prefixes
          const autoPrefixPattern = /^[!#$%^&*~`]{1,2}[a-z]{2,}/i;

          // Check for signatures
          const hasBotSignature = botSignatures.some(re => re.test(textBody));
          const hasAutoPrefix   = autoPrefixPattern.test(textBody.trim());

          // Check message context flags (forwarded count, participant flag)
          const msgCtx     = rawContent?.extendedTextMessage?.contextInfo;
          const forwardedN = msgCtx?.forwardingScore || 0;

          // A user-bot using auto-forward flood (forwarded 100+ times, unnatural)
          const isMassForward = forwardedN > 50;

          if (hasBotSignature || isMassForward) {
            try {
              await sock.groupParticipantsUpdate(from, [sender], 'remove');
              database.clearWarnings(from, sender);
              await sock.sendMessage(from, {
                text:
                  `🤖 *User-Bot Detected & Removed*\n\n` +
                  `@${sender.split('@')[0]} was removed because their account appears to be running an automated bot script.\n\n` +
                  `📌 Reason: ${hasBotSignature ? 'Bot framework signature detected' : 'Mass-forward flood detected'}\n` +
                  `🛡️ Group protection active.`,
                mentions: [sender]
              });
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.error('[UserBot Detector] Error:', err.message);
  }
  // ================== 🤖 END SELF-BOT DETECTOR ==================

    // Anti-group mention protection (check BEFORE prefix check, as these are non-command messages)
    if (isGroup) {
      // Debug logging to confirm we're trying to call the handler
      const groupSettings = database.getGroupSettings(from);
      // Debug log removed
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      try {
        await handleAntigroupmention(sock, msg, groupMetadata);
      } catch (error) {
        console.error('Error in antigroupmention handler:', error);
      }
    }
    
    // Track group message statistics
    if (isGroup) {
      addMessage(from, sender);
    }

    // Return early for non-group messages with no recognizable content
    if (!content || actualMessageTypes.length === 0) return;
    
    // 🔹 Button response should also check unwrapped content
    const btn = content.buttonsResponseMessage || msg.message?.buttonsResponseMessage;
    if (btn) {
      const buttonId = btn.selectedButtonId;
      const displayText = btn.selectedDisplayText;
      
      // Handle button clicks by routing to commands
      if (buttonId === 'btn_menu') {
        // Execute menu command
        const menuCmd = commands.get('menu');
        if (menuCmd) {
          await menuCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      } else if (buttonId === 'btn_ping') {
        // Execute ping command
        const pingCmd = commands.get('ping');
        if (pingCmd) {
          await pingCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      } else if (buttonId === 'btn_help') {
        // Execute list command again (help)
        const listCmd = commands.get('list');
        if (listCmd) {
          await listCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      }
    }
    
    // Get message body from unwrapped content
    let body = '';
    if (content.conversation) {
      body = content.conversation;
    } else if (content.extendedTextMessage) {
      body = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption || '';
    }
    
    body = (body || '').trim();
    
    // Check antiall protection (owner only feature)
    if (isGroup) {
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.antiall) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        const senderIsOwner = isOwner(sender);
        
        if (!senderIsAdmin && !senderIsOwner) {
          const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
          if (botIsAdmin) {
            await sock.sendMessage(from, { delete: msg.key });
            return;
          }
        }
      }
      
      // Anti-tag protection (check BEFORE text check, as tagall can have no text)
      if (groupSettings.antitag && !msg.key.fromMe) {
        const ctx = content.extendedTextMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];
        
        const messageText = (
          body ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          ''
        );
        
        const textMentions = messageText.match(/@[\d+\s\-()~.]+/g) || [];
        const numericMentions = messageText.match(/@\d{10,}/g) || [];
        
        const uniqueNumericMentions = new Set();
        numericMentions.forEach((mention) => {
          const numMatch = mention.match(/@(\d+)/);
          if (numMatch) uniqueNumericMentions.add(numMatch[1]);
        });
        
        const mentionedJidCount = mentionedJids.length;
        const numericMentionCount = uniqueNumericMentions.size;
        const totalMentions = Math.max(mentionedJidCount, numericMentionCount);
        
        if (totalMentions >= 3) {
          try {
            const participants = groupMetadata.participants || [];
            const mentionThreshold = Math.max(3, Math.ceil(participants.length * 0.5));
            const hasManyNumericMentions = numericMentionCount >= 10 ||
              (numericMentionCount >= 5 && numericMentionCount >= mentionThreshold);
            
            if (totalMentions >= mentionThreshold || hasManyNumericMentions) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
              const senderIsOwner = isOwner(sender);
              
              if (!senderIsAdmin && !senderIsOwner) {
                const action = (groupSettings.antitagAction || 'delete').toLowerCase();
                
                if (action === 'delete') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, { 
                      text: '⚠️ *Tagall Detected!*',
                      mentions: [sender]
                    }, { quoted: msg });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }
                } else if (action === 'kick') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }
                  
                  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
                  if (botIsAdmin) {
                    try {
                      await sock.groupParticipantsUpdate(from, [sender], 'remove');
                    } catch (e) {
                      console.error('Failed to kick for antitag:', e);
                    }
                    const usernames = [`@${sender.split('@')[0]}`];
                    await sock.sendMessage(from, {
                      text: `🚫 *Antitag Detected!*\n\n${usernames.join(', ')} has been kicked for tagging all members.`,
                      mentions: [sender],
                    }, { quoted: msg });
                  }
                }
                return;
              }
            }
          } catch (e) {
            console.error('Error during anti-tag enforcement:', e);
          }
        }
      }
    }
    
    // Anti-group mention protection (check BEFORE prefix check, as these are non-command messages)
    if (isGroup) {
      // Debug logging to confirm we're trying to call the handler
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      try {
        await handleAntigroupmention(sock, msg, groupMetadata);
      } catch (error) {
        console.error('Error in antigroupmention handler:', error);
      }
    }
    
    // AutoSticker feature - convert images/videos to stickers automatically
    if (isGroup) { // Process all messages in groups (including bot's own messages)
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.autosticker) {
        const mediaMessage = content?.imageMessage || content?.videoMessage;
        
        // Only process if it's an image or video (not documents)
        if (mediaMessage) {
          // Skip if message has a command prefix (let command handle it)
          if (!body.startsWith(config.prefix)) {
            try {
              // Import sticker command logic
              const stickerCmd = commands.get('sticker');
              if (stickerCmd) {
                // Execute sticker conversion silently
                await stickerCmd.execute(sock, msg, [], {
                  from,
                  sender,
                  isGroup,
                  groupMetadata,
                  isOwner: isOwner(sender),
                  isAdmin: await isAdmin(sock, sender, from, groupMetadata),
                  isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
                  isMod: isMod(sender),
                  reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
                  react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
                });
                return; // Don't process as command after auto-converting
              }
            } catch (error) {
              console.error('[AutoSticker Error]:', error);
              // Continue to normal processing if autosticker fails
            }
          }
        }
      }
    }

     // Check for active bomb games (before prefix check)
    try {
      const bombModule = require('./Commands/fun/bomb');
      if (bombModule.gameState && bombModule.gameState.has(sender)) {
        const bombCommand = commands.get('bomb');
        if (bombCommand && bombCommand.execute) {
          // User has active game, process input
          await bombCommand.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          return; // Don't process as command
        }
      }
    } catch (e) {
      // Silently ignore if bomb command doesn't exist or has errors
    }
    
    // Check for active tictactoe games (before prefix check)
    try {
      const tictactoeModule = require('./Commands/fun/tictactoe');
      if (tictactoeModule.handleTicTacToeMove) {
        // Check if user is in an active game
        const isInGame = Object.values(tictactoeModule.games || {}).some(room => 
          room.id.startsWith('tictactoe') && 
          [room.game.playerX, room.game.playerO].includes(sender) && 
          room.state === 'PLAYING'
        );
        
        if (isInGame) {
          // User has active game, process input
          const handled = await tictactoeModule.handleTicTacToeMove(sock, msg, {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handled) return; // Don't process as command if move was handled
        }
      }
    } catch (e) {
      // Silently ignore if tictactoe command doesn't exist or has errors
    }
    
    
    // Check if message starts with prefix
   if (!body.startsWith(config.prefix)) {

  // 🔗 AntiLink sirf normal messages pe chalega
  if (isGroup) {
    try {
      await handleAntilink(sock, msg, groupMetadata);
    } catch (error) {
      console.error('Error in antilink handler:', error);
    }
  }

  // 🤖 Chatbot response handler - only when not a command
  try {
    const chatbotModule = require('./Commands/admin/chatbot');
    if (chatbotModule && chatbotModule.handleChatbotResponse) {
      await chatbotModule.handleChatbotResponse(sock, from, msg, body, sender);
    }
  } catch (e) {
    // Silently ignore chatbot errors
  }

  return;
}
    
    // Parse command
    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    
    // Get command
    const command = commands.get(commandName);
    if (!command) return;

    // Check if user is banned from using bot commands
    try {
      const bannedPath = path.join(__dirname, 'data', 'banned.json');
      if (fs.existsSync(bannedPath)) {
        const bannedUsers = JSON.parse(fs.readFileSync(bannedPath, 'utf8'));
        const senderPhone = sender.split('@')[0].split(':')[0];
        const isBanned = bannedUsers.some(b => b.split('@')[0].split(':')[0] === senderPhone);
        if (isBanned && !isOwner(sender)) return; // silently ignore banned users
      }
    } catch (_) {}

    // Check self mode (private mode) - only owner can use commands
    if (config.selfMode && !isOwner(sender)) {
      return;
    }
    
    // Permission checks
    if (command.ownerOnly && !isOwner(sender)) {
      return sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    }
    
    if (command.modOnly && !isMod(sender) && !isOwner(sender)) {
      return sock.sendMessage(from, { text: '🔒 This command is only for moderators!' }, { quoted: msg });
    }
    
    if (command.groupOnly && !isGroup) {
      return sock.sendMessage(from, { text: config.messages.groupOnly }, { quoted: msg });
    }
    
    if (command.privateOnly && isGroup) {
      return sock.sendMessage(from, { text: config.messages.privateOnly }, { quoted: msg });
    }
    
    if (command.adminOnly && !(await isAdmin(sock, sender, from, groupMetadata)) && !isOwner(sender)) {
      return sock.sendMessage(from, { text: config.messages.adminOnly }, { quoted: msg });
    }
    
    if (command.botAdminNeeded) {
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      if (!botIsAdmin) {
        return sock.sendMessage(from, { text: config.messages.botAdminNeeded }, { quoted: msg });
      }
    }
    
    // Auto-typing
    if (config.autoTyping) {
      await sock.sendPresenceUpdate('composing', from);
    }
    
    // Execute command
    console.log(`Executing command: ${commandName} from ${sender}`);
    
    await command.execute(sock, msg, args, {
      from,
      sender,
      isGroup,
      groupMetadata,
      isOwner: isOwner(sender),
      isAdmin: await isAdmin(sock, sender, from, groupMetadata),
      isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
      isMod: isMod(sender),
      prefix: config.prefix,
      reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
    });
    
  } catch (error) {
    console.error('Error in message handler:', error);
    
    // Don't send error messages for rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      console.warn('⚠️ Rate limit reached. Skipping error message.');
      return;
    }
    
    try {
      await sock.sendMessage(msg.key.remoteJid, { 
        text: `${config.messages.error}\n\n${error.message}` 
      }, { quoted: msg });
    } catch (e) {
      // Don't log rate limit errors when sending error messages
      if (!e.message || !e.message.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

// Group participant update handler
const handleGroupUpdate = async (sock, update) => {
  try {
    const { id, participants, action } = update;
    
    // Validate group JID before processing
    if (!id || !id.endsWith('@g.us')) {
      return;
    }
    
    const groupSettings = database.getGroupSettings(id);
    
    if (!groupSettings.welcome && !groupSettings.goodbye) return;
    
    const groupMetadata = await getGroupMetadata(sock, id);
    if (!groupMetadata) return; // Skip if metadata unavailable (forbidden or error)
    
    // Helper to extract participant JID
    const getParticipantJid = (participant) => {
      if (typeof participant === 'string') {
        return participant;
      }
      if (participant && participant.id) {
        return participant.id;
      }
      if (participant && typeof participant === 'object') {
        // Try to find JID in object
        return participant.jid || participant.participant || null;
      }
      return null;
    };
    
    for (const participant of participants) {
      const participantJid = getParticipantJid(participant);
      if (!participantJid) {
        console.warn('Could not extract participant JID:', participant);
        continue;
      }
      
      const participantNumber = participantJid.split('@')[0];
      
      if (action === 'add' && groupSettings.welcome) {
        try {
          // Get user's display name - find participant using phoneNumber or JID
          let displayName = participantNumber;
          
          // Try to find participant in group metadata
          const participantInfo = groupMetadata.participants.find(p => {
            const pId = p.id || p.jid || p.participant;
            const pPhone = p.phoneNumber;
            // Match by JID or phoneNumber
            return pId === participantJid || 
                   pId?.split('@')[0] === participantNumber ||
                   pPhone === participantJid ||
                   pPhone?.split('@')[0] === participantNumber;
          });
          
          // Get phoneNumber JID to fetch contact name
          let phoneJid = null;
          if (participantInfo && participantInfo.phoneNumber) {
            phoneJid = participantInfo.phoneNumber;
          } else {
            // Try to normalize participantJid to phoneNumber format
            // If it's a LID, try to convert to phoneNumber
            try {
              const normalized = normalizeJidWithLid(participantJid);
              if (normalized && normalized.includes('@s.whatsapp.net')) {
                phoneJid = normalized;
              }
            } catch (e) {
              // If normalization fails, try using participantJid directly if it's a valid JID
              if (participantJid.includes('@s.whatsapp.net')) {
                phoneJid = participantJid;
              }
            }
          }
          
          // Try to get contact name from phoneNumber JID
          if (phoneJid) {
            try {
              // Method 1: Try to get from contact store if available
              if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                const contact = sock.store.contacts[phoneJid];
                if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                  displayName = contact.notify.trim();
                } else if (contact.name && contact.name.trim() && !contact.name.match(/^\d+$/)) {
                  displayName = contact.name.trim();
                }
              }
              
              // Method 2: Try to fetch contact using onWhatsApp and then check store
              if (displayName === participantNumber) {
                try {
                  await sock.onWhatsApp(phoneJid);
                  
                  // After onWhatsApp, check store again (might populate after check)
                  if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                    const contact = sock.store.contacts[phoneJid];
                    if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                      displayName = contact.notify.trim();
                    }
                  }
                } catch (fetchError) {
                  // Silently handle fetch errors
                }
              }
            } catch (contactError) {
              // Silently handle contact errors
            }
          }
          
          // Final fallback: use participantInfo.notify or name if available
          if (displayName === participantNumber && participantInfo) {
            if (participantInfo.notify && participantInfo.notify.trim() && !participantInfo.notify.match(/^\d+$/)) {
              displayName = participantInfo.notify.trim();
            } else if (participantInfo.name && participantInfo.name.trim() && !participantInfo.name.match(/^\d+$/)) {
              displayName = participantInfo.name.trim();
            }
          }
          
          // Get user's profile picture URL
          let profilePicUrl = '';
          try {
            profilePicUrl = await sock.profilePictureUrl(participantJid, 'image');
          } catch (ppError) {
            // If profile picture not available, use default avatar
            profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
          }
          
          // Get group name and description
          const groupName = groupMetadata.subject || 'the group';
          const groupDesc = groupMetadata.desc || 'No description';
          
          // Get current time string
          const now = new Date();
          const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
          });
          
          // Create formatted welcome message
          const welcomeMsg = `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${displayName} 👋\n┃Member count: #${groupMetadata.participants.length}\n┃𝚃𝙸𝙼𝙴: ${timeString}⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@${displayName}* Welcome to *${groupName}*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${groupDesc}\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName}*`;
          
          // Construct API URL for welcome image
          const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=join&textcolor=white&username=${encodeURIComponent(displayName)}&guildName=${encodeURIComponent(groupName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(profilePicUrl)}`;
          
          // Download the welcome image
          const imageResponse = await axios.get(apiUrl, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data);
          
          // Send the welcome image with formatted caption
          await sock.sendMessage(id, { 
            image: imageBuffer,
            caption: welcomeMsg,
            mentions: [participantJid] 
          });
        } catch (welcomeError) {
          // Fallback to text message if image generation fails
          console.error('Welcome image error:', welcomeError);
          let message = groupSettings.welcomeMessage || 'Welcome @user to @group! 👋\nEnjoy your stay!';
          message = message.replace('@user', `@${participantNumber}`);
          message = message.replace('@group', groupMetadata.subject || 'the group');
          
          await sock.sendMessage(id, { 
            text: message, 
            mentions: [participantJid] 
          });
        }
      } else if (action === 'remove' && groupSettings.goodbye) {
        try {
          // Get user's display name - find participant using phoneNumber or JID
          let displayName = participantNumber;
          
          // Try to find participant in group metadata (before they left)
          const participantInfo = groupMetadata.participants.find(p => {
            const pId = p.id || p.jid || p.participant;
            const pPhone = p.phoneNumber;
            // Match by JID or phoneNumber
            return pId === participantJid || 
                   pId?.split('@')[0] === participantNumber ||
                   pPhone === participantJid ||
                   pPhone?.split('@')[0] === participantNumber;
          });
          
          // Get phoneNumber JID to fetch contact name
          let phoneJid = null;
          if (participantInfo && participantInfo.phoneNumber) {
            phoneJid = participantInfo.phoneNumber;
          } else {
            // Try to normalize participantJid to phoneNumber format
            try {
              const normalized = normalizeJidWithLid(participantJid);
              if (normalized && normalized.includes('@s.whatsapp.net')) {
                phoneJid = normalized;
              }
            } catch (e) {
              if (participantJid.includes('@s.whatsapp.net')) {
                phoneJid = participantJid;
              }
            }
          }
          
          // Try to get contact name from phoneNumber JID
          if (phoneJid) {
            try {
              // Method 1: Try to get from contact store if available
              if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                const contact = sock.store.contacts[phoneJid];
                if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                  displayName = contact.notify.trim();
                } else if (contact.name && contact.name.trim() && !contact.name.match(/^\d+$/)) {
                  displayName = contact.name.trim();
                }
              }
              
              // Method 2: Try to fetch contact using onWhatsApp and then check store
              if (displayName === participantNumber) {
                try {
                  await sock.onWhatsApp(phoneJid);
                  
                  // After onWhatsApp, check store again
                  if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                    const contact = sock.store.contacts[phoneJid];
                    if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                      displayName = contact.notify.trim();
                    }
                  }
                } catch (fetchError) {
                  // Silently handle fetch errors
                }
              }
            } catch (contactError) {
              // Silently handle contact errors
            }
          }
          
          // Final fallback: use participantInfo.notify or name if available
          if (displayName === participantNumber && participantInfo) {
            if (participantInfo.notify && participantInfo.notify.trim() && !participantInfo.notify.match(/^\d+$/)) {
              displayName = participantInfo.notify.trim();
            } else if (participantInfo.name && participantInfo.name.trim() && !participantInfo.name.match(/^\d+$/)) {
              displayName = participantInfo.name.trim();
            }
          }
          
          // Get user's profile picture URL
          let profilePicUrl = '';
          try {
            profilePicUrl = await sock.profilePictureUrl(participantJid, 'image');
          } catch (ppError) {
            // If profile picture not available, use default avatar
            profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
          }
          
          // Get group name and description
          const groupName = groupMetadata.subject || 'the group';
          const groupDesc = groupMetadata.desc || 'No description';
          
          // Get current time string
          const now = new Date();
          const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
          });
          
          // Create simple goodbye message
          const goodbyeMsg = `Goodbye @${displayName} 👋 We will never miss you!`;
          
          // Construct API URL for goodbye image (using leave type)
          const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=leave&textcolor=white&username=${encodeURIComponent(displayName)}&guildName=${encodeURIComponent(groupName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(profilePicUrl)}`;
          
          // Download the goodbye image
          const imageResponse = await axios.get(apiUrl, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data);
          
          // Send the goodbye image with caption
          await sock.sendMessage(id, { 
            image: imageBuffer,
            caption: goodbyeMsg,
            mentions: [participantJid] 
          });
        } catch (goodbyeError) {
          // Fallback to simple goodbye message
          console.error('Goodbye error:', goodbyeError);
          const goodbyeMsg = `Goodbye @${participantNumber} 👋 We will never miss you! 💀`;
          
          await sock.sendMessage(id, { 
            text: goodbyeMsg, 
            mentions: [participantJid] 
          });
        }
      }
    }
  } catch (error) {
    // Silently handle forbidden errors and other group metadata errors
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Silently skip forbidden groups
      return;
    }
    // Only log non-forbidden errors
    if (!error.message || !error.message.includes('forbidden')) {
      console.error('Error handling group update:', error);
    }
  }
};

// Antilink handler
const handleAntilink = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antilink) return;
  
    const body = msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.imageMessage?.caption || 
                  msg.message?.videoMessage?.caption || '';
           
   
    // Comprehensive link detection - matches links with or without protocols
    // Matches: https://t.me/..., http://wa.me/..., t.me/..., wa.me/..., google.com, telegram.com, etc.
    // Pattern breakdown:
    // 1. (https?:\/\/)? - Optional http:// or https://
    // 2. ([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.)+[a-zA-Z]{2,} - Domain pattern (e.g., google.com, t.me)
    // 3. (\/[^\s]*)? - Optional path after domain
    const linkPattern = /(https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(\/[^\s]*)?/i;
    
    // Check for any links (with or without protocol)
  if (linkPattern.test(body)) {
  const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
  const senderIsOwner = isOwner(sender);

  if (senderIsAdmin || senderIsOwner) return;
  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);

  const userKey = `${from}_${sender}`;
  let warnings = linkWarnings.get(userKey) || 0;
  warnings += 1;
  linkWarnings.set(userKey, warnings);

  // ⚠️ WARNING
  await sock.sendMessage(from, {
    text: `⚠️ Anti-link Warning\n\n@${sender.split('@')[0]} ${warnings}/3`,
    mentions: [sender]
  });

  // ❌ DELETE
  try {
    await sock.sendMessage(from, { delete: msg.key });
  } catch {}

  // 🚫 KICK AFTER 3
  if (warnings >= 3) {
    if (botIsAdmin) {
      await sock.groupParticipantsUpdate(from, [sender], 'remove');

      await sock.sendMessage(from, {
        text: `🚫 @${sender.split('@')[0]} kicked (3 warnings)`,
        mentions: [sender]
      });

      linkWarnings.delete(userKey);
    }
  }
}
  } catch (error) {
    console.error('Error in antilink handler:', error);
  }
};


// Anti-group mention handler
const handleAntigroupmention = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    
    // Debug logging to confirm handler is being called
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Log simplified message info instead of full structure to avoid huge logs
      // Debug log removed
    }
    
    if (!groupSettings.antigroupmention) return;
    
    // Check if this is a forwarded status message that mentions the group
    // Comprehensive detection for various status mention message types
    let isForwardedStatus = false;
    
    if (msg.message) {
      // Direct checks for known status mention message types
      isForwardedStatus = isForwardedStatus || !!msg.message.groupStatusMentionMessage;
      isForwardedStatus = isForwardedStatus || 
        (msg.message.protocolMessage && msg.message.protocolMessage.type === 25); // STATUS_MENTION_MESSAGE
      
      // Check for forwarded newsletter info in various message types
      isForwardedStatus = isForwardedStatus || 
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && 
         msg.message.extendedTextMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.conversation && msg.message.contextInfo && 
         msg.message.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.imageMessage && msg.message.imageMessage.contextInfo && 
         msg.message.imageMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.videoMessage && msg.message.videoMessage.contextInfo && 
         msg.message.videoMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.contextInfo && msg.message.contextInfo.forwardedNewsletterMessageInfo);
      
      // Generic check for any forwarded message
      if (msg.message.contextInfo) {
        const ctx = msg.message.contextInfo;
        isForwardedStatus = isForwardedStatus || !!ctx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!ctx.forwardingScore;
        // Additional check for forwarded status specifically
        isForwardedStatus = isForwardedStatus || !!ctx.quotedMessageTimestamp;
      }
      
      // Additional checks for forwarded messages
      if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
        const extCtx = msg.message.extendedTextMessage.contextInfo;
        isForwardedStatus = isForwardedStatus || !!extCtx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!extCtx.forwardingScore;
      }
    }
    
    // Additional debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    // Additional debug logging to help identify message structure
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Debug log removed
      if (msg.message) {
        // Debug log removed
        // Log specific message types that might indicate a forwarded status
        if (msg.message.protocolMessage) {
          // Debug log removed
        }
        if (msg.message.contextInfo) {
          // Debug log removed
        }
        if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
          // Debug log removed
        }
      }
    }
    
    // Debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    if (isForwardedStatus) {
      if (groupSettings.antigroupmention) {
        // Process forwarded status message
      }
      
      const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = isOwner(sender);
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      // Don't act on admins or owners
      if (senderIsAdmin || senderIsOwner) return;
      
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      const action = (groupSettings.antigroupmentionAction || 'delete').toLowerCase();
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      if (action === 'kick' && botIsAdmin) {
        try {
          if (groupSettings.antigroupmention) {
            // Delete and kick user
          }
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          // Silent removal
        } catch (e) {
          console.error('Failed to kick for antigroupmention:', e);
        }
      } else {
        // Default: delete message
        try {
          if (groupSettings.antigroupmention) {
            // Delete message
          }
          await sock.sendMessage(from, { delete: msg.key });
          // Silent deletion
        } catch (e) {
          console.error('Failed to delete message for antigroupmention:', e);
        }
      }
    } else if (groupSettings.antigroupmention) {
      // Debug log removed
    }
  } catch (error) {
    console.error('Error in antigroupmention handler:', error);
  }
};


// Anti-call feature initializer
const initializeAntiCall = (sock) => {
  // Anti-call feature - reject and block incoming calls
  sock.ev.on('call', async (calls) => {
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
    } catch (err) {
      console.error('[ANTICALL ERROR]', err);
    }
  });
};

// Wrap handleMessage with concurrency queue for heavy-load handling
const handleMessageQueued = (sock, msg, sessionConfig) =>
  runWithQueue(() => handleMessage(sock, msg, sessionConfig));
  if (m.key && m.key.remoteJid === 'status.broadcast') {
    try {
      await sock.readMessages([m.key]);
      console.log(`✅ Status Seen: ${m.pushName || 'User'}`);
      return; 
    } catch (e) {}
  }
  
module.exports = {
  handleMessage: handleMessageQueued,
  handleGroupUpdate,
  handleAntilink,
  handleAntigroupmention,
  initializeAntiCall,
  isOwner,
  isAdmin,
  isBotAdmin,
  isMod,
  getGroupMetadata,
  findParticipant
};
