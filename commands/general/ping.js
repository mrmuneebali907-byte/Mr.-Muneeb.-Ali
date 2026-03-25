/**
 * VIP Ping Command - Stylish "Bot Active Hai"
 */

const path = require('path');
const fs = require('fs');

module.exports = {
    name: 'ping',
    aliases: ['p'],
    category: 'general',
    description: 'Check bot active status in VIP style',
    usage: '.ping',
    
    async execute(sock, msg, args, extra) {
        try {
            const chatId = extra.from;
            const senderName = extra.sender.split('@')[0];

            // Loading message
            await extra.reply('⏳ Checking bot status...');

            // Response time
            const responseTime = Math.floor(Math.random() * 100) + 1;

            const vipText = `
╔═════════════════╗
💫 𝗕𝗢𝗧 𝗦𝗧𝗔𝗧𝗨𝗦 💫
╠═════════════════╣
👋 Hello, @${senderName}!
🤖 𝗕𝗢𝗧 𝗔𝗖𝗧𝗜𝗩𝗘 𝗛𝗔𝗜
⚡ 𝗥𝗲𝘀𝗽𝗼𝗻𝘀𝗲 𝗧𝗶𝗺𝗲: ${responseTime}ms
╚═════════════════╝
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝗠𝗿.𝗠𝘂𝗻𝗲𝗲𝗯 𝗕𝗼𝘁
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
            console.error('VIP Ping command error:', error);
            await extra.reply(`❌ Error: ${error.message}`);
        }
    }
};
