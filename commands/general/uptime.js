/**
 * Alive Command - Stylish VIP Bot Status with Poetry
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

function formatUptime(seconds) {
  if (seconds <= 0) return '0 seconds';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} ${secs === 1 ? 'second' : 'seconds'}`);
  return parts.join(', ');
}

module.exports = {
  name: 'alive',
  aliases: ['up', 'botalive', 'status'],
  category: 'general',
  description: 'Show bot status in VIP stylish format',
  usage: '.alive',

  async execute(sock, msg, args, extra) {
    try {
      const chatId = extra.from;
      const senderName = extra.sender.split('@')[0];

      const uptimeSeconds = process.uptime();
      const uptime = formatUptime(uptimeSeconds);

      const botName = config.botName || 'Bot';
      const botVersion = 'V1.0.2';

      const vipText = `
╔═════════════════════╗
🕵️‍♂️ 𝗔𝗟𝗜𝗩𝗘 𝗖𝗛𝗘𝗖𝗞 🕵️‍♂️
╠═════════════════════╣
👋 Hello, @${senderName}!

🤖 𝗕𝗢𝗧 𝗔𝗖𝗧𝗜𝗩𝗘 ⚡
🧬 𝗩𝗲𝗿𝘀𝗶𝗼𝗻: ${botVersion}
⏱️ 𝗨𝗽𝘁𝗶𝗺𝗲: ${uptime}

💬 "𝗦𝗵𝗮𝗱𝗼𝘄𝘀 𝗳𝗹𝗶𝗰𝗸𝗲𝗿, 𝘁𝗵𝗲 𝗯𝗼𝘁 𝗿𝘂𝗻𝘀 𝗶𝗻 𝘁𝗵𝗲 𝗻𝗶𝗴𝗵𝘁,
      𝗖𝗵𝗮𝗹𝗹𝗲𝗻𝗴𝗲 𝗺𝗲 𝗼𝗻𝗹𝘆 𝗶𝗳 𝘆𝗼𝘂 𝗱𝗮𝗿𝗲 𝗮𝗹𝗶𝘃𝗲." 

> ᴘᴏᴡᴇʀᴇᴅ ʙ𝘆 𝗠𝗿.𝗠𝘂𝗻𝗲𝗲𝗯 𝗕𝗼𝘁
╚═════════════════════╝
`;

      const imagePath = path.join(__dirname, '../../utils/bot_image.jpg');

      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        await sock.sendMessage(chatId, {
          image: imageBuffer,
          caption: vipText,
          mentions: [extra.sender]
        });
      } else {
        await sock.sendMessage(chatId, {
          text: vipText,
          mentions: [extra.sender]
        });
      }

    } catch (error) {
      console.error('Alive command error:', error);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};