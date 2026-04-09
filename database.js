/**
 * database.js - JSON-based flat-file database for group settings, users, warnings
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
  warnings: path.join(DATA_DIR, 'warnings.json'),
  banned: path.join(DATA_DIR, 'banned.json'),
  moderators: path.join(DATA_DIR, 'moderators.json'),
};

function readJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (_) {}
  return defaultVal;
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Database] Write error:', e.message);
  }
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
  const banned = getBanned();
  return banned.includes(userId);
}

function banUser(userId) {
  const banned = getBanned();
  if (!banned.includes(userId)) {
    banned.push(userId);
    writeJSON(FILES.banned, banned);
  }
}

function unbanUser(userId) {
  let banned = getBanned();
  banned = banned.filter(u => u !== userId);
  writeJSON(FILES.banned, banned);
}

// ── Moderators ────────────────────────────────────────────────────────────────

function getModerators() {
  return readJSON(FILES.moderators, []);
}

function isModerator(number) {
  const mods = getModerators();
  return mods.includes(number);
}

function addModerator(number) {
  const mods = getModerators();
  if (!mods.includes(number)) {
    mods.push(number);
    writeJSON(FILES.moderators, mods);
  }
}

function removeModerator(number) {
  let mods = getModerators();
  mods = mods.filter(m => m !== number);
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
