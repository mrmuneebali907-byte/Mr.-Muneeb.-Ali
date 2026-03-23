/**
 * List Command
 * Show all commands with descriptions
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { loadCommands } = require('../../utils/commandLoader');
const { sendButtons } = require('gifted-btns');

module.exports = {
  name: 'list',
  aliases: [],
  description: 'List all commands with descriptions',
  usage: '.list',
  category: 'general',
  
  async execute(sock, msg, args, extra) {
    try {
      const prefix = config.prefix;
      const commands = loadCommands();
      const categories = {};
      
      // Group commands by category
      commands.forEach((cmd, name) => {
        if (cmd.name === name) { // Only count main command names, not aliases
          const category = (cmd.category || 'other').toLowerCase();
          if (!categories[category]) {
            categories[category] = [];
          }
          categories[category].push({
            label: cmd.description || '',
            names: [cmd.name].concat(cmd.aliases || []),
          });
        }
      });
      
      let menu = `*${config.botName} - Commands List*\n`;
      menu += `Prefix: *${prefix}*\n\n`;
      
      const orderedCats = Object.keys(categories).sort();
      
      for (const cat of orderedCats) {
        menu += `*📂 ${cat.toUpperCase()}*\n`;
        for (const entry of categories[cat]) {
          const cmdList = entry.names.map((n) => `${prefix}${n}`).join(', ');
          const label = entry.label || '';
          menu += label ? `• \`${cmdList}\` - ${label}\n` : `• ${cmdList}\n`;
        }
        menu += '\n';
      }
      
      menu = menu.trimEnd();
      
      
      // Send message with buttons using gifted-btns
      await sendButtons(sock, extra.from, {
        title: '',
        text: menu,
        footer: `> *Powered by ${config.botName}*`,
        buttons: [
          {
            {
  name: 'cta_url',
  buttonParamsJson: JSON.stringify({
   display_text: '🎵 𝑴𝒖𝒏𝒆𝒆𝒃 𝐊𝐢𝐧𝐠',
    url: 'https://www.tiktok.com/@its.muneeb.king09'
  })
},
          {
              name: 'cta_url',
  buttonParamsJson: JSON.stringify({
    display_text: '💻 𝙈𝙮 𝐆𝐢𝐭𝐇𝐮𝐛',
    url: 'https://github.com/mrmuneebali907-byte'
  })
},
          {
            {
  name: 'cta_url',
  buttonParamsJson: JSON.stringify({
    display_text: '🤖 𝑴𝒓𝑴𝒖𝒏𝒆𝒆𝒃-𝐀𝐈 𝐂𝐨𝐦𝐦𝐮𝐧𝐢𝐭𝐲',
    url: 'https://whatsapp.com/channel/0029VbCXea4FcowFy73gEu3w'
  })
}
        ]
      }, { quoted: msg });
      
    } catch (err) {
      console.error('list.js error:', err);
      await extra.reply('❌ Failed to load commands list.');
    }
  }
};

