const fs = require('fs');
const { channelInfo } = require('../lib/messageConfig');
const isAdmin = require('../lib/isAdmin');
const { isSudo } = require('../lib/index');

async function banCommand(sock, chatId, message) {
    const isGroup = chatId.endsWith('@g.us');
    if (isGroup) {
        const senderId = message.key.participant || message.key.remoteJid;
        const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);
        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Please make the bot an admin to use .ban', ...channelInfo }, { quoted: message });
            return;
        }
        if (!isSenderAdmin && !message.key.fromMe) {
            await sock.sendMessage(chatId, { text: 'Only group admins can use .ban', ...channelInfo }, { quoted: message });
            return;
        }
    } else {
        const senderId = message.key.participant || message.key.remoteJid;
        const senderIsSudo = await isSudo(senderId);
        if (!message.key.fromMe && !senderIsSudo) {
            await sock.sendMessage(chatId, { text: 'Only owner/sudo can use .ban in private chat', ...channelInfo }, { quoted: message });
            return;
        }
    }
    let userToBan;
    
    if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
        userToBan = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
    } else if (message.message?.extendedTextMessage?.contextInfo?.participant) {
        userToBan = message.message.extendedTextMessage.contextInfo.participant;
    }
    
    if (!userToBan) {
        await sock.sendMessage(chatId, { 
            text: 'Please mention the user or reply to their message to ban!', 
            ...channelInfo 
        });
        return;
    }

    try {
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        if (userToBan === botId || userToBan === botId.replace('@s.whatsapp.net', '@lid')) {
            await sock.sendMessage(chatId, { text: 'You cannot ban the bot account.', ...channelInfo }, { quoted: message });
            return;
        }
    } catch {}

    try {
        const bannedUsers = JSON.parse(fs.readFileSync('./data/banned.json'));
        if (!bannedUsers.includes(userToBan)) {
            bannedUsers.push(userToBan);
            fs.writeFileSync('./data/banned.json', JSON.stringify(bannedUsers, null, 2));
            
            const adminName = message.pushName || "Admin";

            await sock.sendMessage(chatId, {
                text: `╭━━━❰ ⚠️ 𝘽𝘼𝙉 𝘼𝘾𝙏𝙄𝙊𝙉 ❱━━━╮
┃
┃ 👑 𝘼𝙙𝙢𝙞𝙣 : ${adminName}
┃
┃ 𝙅𝙖𝙖𝙣𝙞... 𝘼𝙟 𝘽𝙤𝙩 𝙉𝙚
┃ 𝙏𝙝𝙤𝙙𝙖 𝘼𝙩𝙩𝙞𝙩𝙪𝙙𝙚
┃ 𝘿𝙞𝙠𝙝𝙖 𝘿𝙞𝙮𝙖 😎
┃
┃ 🔒 𝘽𝙖𝙣𝙣𝙚𝙙 𝙐𝙨𝙚𝙧
┃ @${userToBan.split('@')[0]}
┃
┃ ⏰ 𝙏𝙞𝙢𝙚
┃ ${new Date().toLocaleTimeString()}
┃
┃ 𝘼𝙗 𝙔𝙚 𝙐𝙨𝙚𝙧
┃ 𝘼𝙡𝙞 𝘽𝙤𝙩
┃ 𝙐𝙨𝙚 𝙉𝙖𝙝𝙞 𝙆𝙖𝙧 𝙎𝙖𝙠𝙩𝙖 🙂
┃
╰━━━━━━━━━━━━━━━━━━╯`,
                mentions: [userToBan],
                ...channelInfo
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, {
                text: `╭━━━❰ ⚠️ 𝘼𝙇𝙍𝙀𝘼𝘿𝙔 𝘽𝘼𝙉𝙉𝙀𝘿 ❱━━━╮
┃
┃ 𝙅𝙖𝙖𝙣𝙞... 𝙔𝙚 𝙐𝙨𝙚𝙧
┃ 𝙋𝙚𝙝𝙡𝙚 𝙎𝙚 𝙃𝙞
┃ 𝘼𝙡𝙞 𝘽𝙤𝙩 𝙎𝙚
┃ 𝘽𝙖𝙣 𝙃𝙖𝙞 🙂
┃
┃ 🔒 𝙐𝙨𝙚𝙧
┃ @${userToBan.split('@')[0]}
┃
┃ 𝘼𝙙𝙢𝙞𝙣 𝘼𝙗
┃ 𝙎𝙞𝙧𝙛 𝙐𝙣𝙗𝙖𝙣
┃ 𝙆𝙖𝙧 𝙎𝙖𝙠𝙩𝙖 𝙃𝙖𝙞
┃
╰━━━━━━━━━━━━━━━━━━╯`,
                mentions: [userToBan],
                ...channelInfo
            }, { quoted: message });
        }
    } catch (error) {
        console.error('Error in ban command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to ban user!', ...channelInfo });
    }
}

module.exports = banCommand;
