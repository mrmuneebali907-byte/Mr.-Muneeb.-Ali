const config = require('../../config');
const { loadCommands } = require('../../utils/commandLoader');

module.exports = {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'general',
  description: 'Show all available commands',
  usage: '.menu',
  
  async execute(sock, msg, args, extra) {
    try {
      const commands = loadCommands();
      const categories = {};
      
      // BOSS, ye hissa handler se saare commands uthayega
      commands.forEach((cmd, name) => {
        if (cmd.name === name) { 
          if (!categories[cmd.category]) {
            categories[cmd.category] = [];
          }
          categories[cmd.category].push(cmd);
        }
      });
      
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName : [config.ownerName];
      const displayOwner = ownerNames[0] || config.ownerName || 'Bot Owner';
      
      let menuText = `╭━━『 *${config.botName}* 』━━╮\n\n`;
      menuText += `👋 Hello @${extra.sender.split('@')[0]}!\n\n`;
      menuText += `⚡ Prefix: ${config.prefix}\n`;
      menuText += `📦 Total Commands: ${commands.size}\n`;
      menuText += `👑 Owner: ${displayOwner}\n\n`;
      
      // AUTOMATIC SECTION GENERATOR
      // Aap jis bhi folder/category mein command add karenge, wo yahan khud show hoga
      Object.keys(categories).sort().forEach(cat => {
        const categoryName = cat.toUpperCase();
        
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ ➜ ${categoryName} COMMANDS\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        
        categories[cat].forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      });
      
      menuText += `╰━━━━━━━━━━━━━━━━━\n\n`;
      menuText += `💡 Type ${config.prefix}help <command> for more info\n`;
      
      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(__dirname, '../../utils/bot_image.jpg');
      
      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        await sock.sendMessage(extra.from, {
          image: imageBuffer,
          caption: menuText,
          mentions: [extra.sender],
          contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: config.newsletterJid || '120363406636688300@newsletter',
              newsletterName: config.botName,
              serverMessageId: -1
            }
          }
        }, { quoted: msg });
      } else {
        await sock.sendMessage(extra.from, { text: menuText, mentions: [extra.sender] }, { quoted: msg });
      }
      
    } catch (error) {
      console.error('Menu Error:', error);
      await sock.sendMessage(extra.from, { text: '❌ Error loading menu.' });
    }
  }
};
            
