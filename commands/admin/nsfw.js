'use strict';
/**
 * .nsfw on | off
 * Toggles per-group NSFW content detection.
 * When ON: images, videos, stickers, and text are scanned. NSFW content is
 * deleted and the sender is removed (if bot is admin).
 * When OFF: no scanning runs in this group.
 */

const database = require('../../database');

module.exports = {
  name       : 'nsfw',
  aliases    : [],
  category   : 'admin',
  description: 'Toggle NSFW content detection (image/video/sticker/text)',
  usage      : '.nsfw on | .nsfw off',
  groupOnly  : true,
  adminOnly  : true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const { from, reply } = extra;
      const gs  = database.getGroupSettings(from);
      const opt = (args[0] || '').toLowerCase();

      if (!opt) {
        const state = gs.nsfw ? '✅ ON' : '❌ OFF';
        return reply(
          `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
          `🔞 *NSFW Detection Status*\n\n` +
          `Current: *${state}*\n\n` +
          `Commands:\n` +
          `  *.nsfw on*  — Enable detection\n` +
          `  *.nsfw off* — Disable detection\n\n` +
          `Detects: images, videos, stickers, text/links`
        );
      }

      if (opt === 'on') {
        if (gs.nsfw) return reply('🔞 NSFW detection is already *ON* in this group.');
        database.updateGroupSettings(from, { nsfw: true });
        return await sock.sendMessage(from, {
          text:
            `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
            `✅ *NSFW Detection Enabled!*\n\n` +
            `Adult images, videos, stickers, and links will be automatically\n` +
            `deleted and the sender will be removed from this group.\n\n` +
            `> Owner & admins are always exempt.`
        }, { quoted: msg });
      }

      if (opt === 'off') {
        if (!gs.nsfw) return reply('🔞 NSFW detection is already *OFF* in this group.');
        database.updateGroupSettings(from, { nsfw: false });
        return await sock.sendMessage(from, {
          text:
            `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
            `❌ *NSFW Detection Disabled*\n\n` +
            `NSFW scanning is now OFF for this group.`
        }, { quoted: msg });
      }

      return reply(`❌ Unknown option "*${opt}*". Use *.nsfw on* or *.nsfw off*`);

    } catch (err) {
      console.error('[NSFW Cmd]', err?.message || err);
      await extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
