/**
 * database.js - JSON-based flat-file database for group settings, users, warnings
 *
 * Write-lock: all file writes are serialised through a per-file async queue
 * so that 12 concurrent sessions can never corrupt a JSON file by writing
 * at the same time.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FILES = {
  groupSettings: path.join(DATA_DIR, 'groupSettings.json'),
  warnings:      path.join(DATA_DIR, 'warnings.json'),
  banned:        path.join(DATA_DIR, 'banned.json'),
  moderators:    path.join(DATA_DIR, 'moderators.json'),
};

// ── Per-file write-lock queues ─────────────────────────────────────────────────
// Each file has its own queue. Concurrent writes wait their turn instead of
// stomping on each other.
const _writeQueues  = new Map();
const _writeBusy    = new Map();

async function _runWriteQueue(file) {
  if (_writeBusy.get(file)) return;
  _writeBusy.set(file, true);
  const queue = _writeQueues.get(file) || [];
  while (queue.length > 0) {
    const task = queue.shift();
    try { await task(); } catch (_) {}
  }
  _writeBusy.set(file, false);
}

function _enqueueWrite(file, task) {
  if (!_writeQueues.has(file)) _writeQueues.set(file, []);
  return new Promise((resolve, reject) => {
    _writeQueues.get(file).push(async () => {
      try { resolve(await task()); }
      catch (e) { reject(e); }
    });
    _runWriteQueue(file);
  });
}

// ── Raw read/write ─────────────────────────────────────────────────────────────

function readJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (_) {}
  return defaultVal;
}

function _writeJSONSync(file, data) {
  // Write to temp file then rename — atomic on most OSes
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function writeJSON(file, data) {
  return _enqueueWrite(file, () => _writeJSONSync(file, data));
}

// ── Group Settings ────────────────────────────────────────────────────────────

function getGroupSettings(groupId) {
  const all = readJSON(FILES.groupSettings, {});
  return { ...config.defaultGroupSettings, ...(all[groupId] || {}) };
}

function updateGroupSettings(groupId, updates) {
  const all = readJSON(FILES.groupSettings, {});
  all[groupId] = { ...(all[groupId] || {}), ...updates };
  writeJSON(FILES.groupSettings, all);
  return all[groupId];
}

// ── Warnings ──────────────────────────────────────────────────────────────────

function getWarnings(groupId, userId) {
  const all = readJSON(FILES.warnings, {});
  const key = `${groupId}:${userId}`;
  return all[key] || { count: 0, reasons: [] };
}

function addWarning(groupId, userId, reason) {
  const all = readJSON(FILES.warnings, {});
  const key = `${groupId}:${userId}`;
  if (!all[key]) all[key] = { count: 0, reasons: [] };
  all[key].count += 1;
  all[key].reasons.push(reason || 'No reason');
  writeJSON(FILES.warnings, all);
  return all[key];
}

function clearWarnings(groupId, userId) {
  const all = readJSON(FILES.warnings, {});
  const key = `${groupId}:${userId}`;
  delete all[key];
  writeJSON(FILES.warnings, all);
}

// ── Banned Users ──────────────────────────────────────────────────────────────

function getBanned() {
  return readJSON(FILES.banned, []);
}

function isBanned(userId) {
  return getBanned().includes(userId);
}

function banUser(userId) {
  const banned = getBanned();
  if (!banned.includes(userId)) {
    banned.push(userId);
    writeJSON(FILES.banned, banned);
  }
}

function unbanUser(userId) {
  const banned = getBanned().filter(u => u !== userId);
  writeJSON(FILES.banned, banned);
}

// ── Moderators ────────────────────────────────────────────────────────────────

function getModerators() {
  return readJSON(FILES.moderators, []);
}

function isModerator(number) {
  return getModerators().includes(number);
}

function addModerator(number) {
  const mods = getModerators();
  if (!mods.includes(number)) {
    mods.push(number);
    writeJSON(FILES.moderators, mods);
  }
}

function removeModerator(number) {
  const mods = getModerators().filter(m => m !== number);
  writeJSON(FILES.moderators, mods);
}

module.exports = {
  getGroupSettings,
  updateGroupSettings,
  getWarnings,
  addWarning,
  clearWarnings,
  getBanned,
  isBanned,
  banUser,
  unbanUser,
  getModerators,
  isModerator,
  addModerator,
  removeModerator,
};
