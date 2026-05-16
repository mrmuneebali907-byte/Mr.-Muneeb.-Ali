'use strict';
/**
 * .antiuserbot on | off
 * Toggles per-group anti-userbot detection.
 * When ON: detects bots / suspicious automated accounts by scoring message
 * patterns (interactive payloads, mass-forward floods, repeated identical
 * messages, foreign-prefix commands, bot-name patterns).
 * Detected bots are immediately removed from the group.
 */

const database = require('../../database');

module.exports = {
  name       : 'antiuserbot',
  aliases    : ['antibots', 'antibot2'],
  category   : 'admin',
  description: 'Toggle anti-userbot / suspicious-account detection',
  usage      : '.antiuserbot on | .antiuserbot off',
  groupOnly  : true,
  adminOnly  : true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const { from, reply } = extra;
      const gs  = database.getGroupSettings(from);
      const opt = (args[0] || '').toLowerCase();

      if (!opt) {
        const state = gs.antiuserbot ? '✅ ON' : '❌ OFF';
        return reply(
          `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
          `🤖 *Anti-Userbot Status*\n\n` +
          `Current: *${state}*\n\n` +
          `Commands:\n` +
          `  *.antiuserbot on*  — Enable protection\n` +
          `  *.antiuserbot off* — Disable protection\n\n` +
          `Detects:\n` +
          `  • Bot-style interactive payloads\n` +
          `  • Message flood / spam bursts\n` +
          `  • Repeated identical messages\n` +
          `  • Known bot-name patterns\n` +
          `  • Foreign bot command prefixes`
        );
      }

      if (opt === 'on') {
        if (gs.antiuserbot) {
          return reply('🤖 Anti-userbot detection is already *ON* in this group.');
        }
        database.updateGroupSettings(from, { antiuserbot: true });
        return await sock.sendMessage(from, {
          text:
            `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
            `✅ *Anti-Userbot Protection Enabled!*\n\n` +
            `Suspicious bots and automated accounts will be\n` +
            `detected and removed from this group automatically.\n\n` +
            `> Admins and owner are always exempt.`
        }, { quoted: msg });
      }

      if (opt === 'off') {
        if (!gs.antiuserbot) {
          return reply('🤖 Anti-userbot detection is already *OFF* in this group.');
        }
        database.updateGroupSettings(from, { antiuserbot: false });
        return await sock.sendMessage(from, {
          text:
            `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
            `❌ *Anti-Userbot Protection Disabled*\n\n` +
            `Bot detection is now OFF for this group.`
        }, { quoted: msg });
      }

      return reply(`❌ Unknown option "*${opt}*". Use *.antiuserbot on* or *.antiuserbot off*`);

    } catch (err) {
      console.error('[AntiUserbot Cmd]', err?.message || err);
      await extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
