/**
 * VIP Ping Command - Stylish "Bot Active Hai" with bot image
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

            // Send initial loading message
            const sent = await extra.reply('⏳ Checking bot status...');

            // Calculate response time
            const start = Date.now();
            const end = Date.now();
            const responseTime = end - start;

            // Stylish VIP box text
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

            // Bot image path
            const imagePath = path.join(__dirname, '../../utils/bot_image.jpg');
            if (fs.existsSync(imagePath)) {
                const imageBuffer = fs.readFileSync(imagePath);
                await sock.sendMessage(chatId, {
                    image: imageBuffer,
                    caption: vipText,
                    mentions: [extra.sender],
                    edit: sent.key
                });
            } else {
                // If image not found, send only VIP text
                await sock.sendMessage(chatId, {
                    text: vipText,
                    mentions: [extra.sender],
                    edit: sent.key
                });
            }

        } catch (error) {
            console.error('VIP Ping command error:', error);
            await extra.reply(`❌ Error: ${error.message}`);
        }
    }
};