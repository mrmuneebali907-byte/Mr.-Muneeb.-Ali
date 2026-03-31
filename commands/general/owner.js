/**
 * Owner Command - Sends bot owner's contact card + intro video
 */

const config = require('../../config');
const axios  = require('axios');

// Direct-download fallback video (publicly hosted MP4)
const FALLBACK_VIDEO_URL = 'https://www.tikwm.com/video/media/hdplay/7621473568093900040.mp4';
const TIKTOK_URL         = 'https://vt.tiktok.com/ZSHNdR1KU/';
const VIDEO_CAPTION      = '🎬 This is my owner 🔥';

/**
 * Try to download a video buffer from the given URL.
 * Follows redirects, enforces a 20 s timeout, and verifies content-type is video.
 */
const downloadVideoBuffer = async (url) => {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 15,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'video/*, */*'
    }
  });

  const ct = (res.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('video') && !ct.includes('octet-stream')) {
    throw new Error(`Non-video content-type: ${ct}`);
  }
  return Buffer.from(res.data);
};

module.exports = {
  name: 'owner',
  aliases: ['creator', 'dev', 'botowner'],
  category: 'general',
  description: 'Show bot owner contact information',
  usage: '.owner',
  ownerOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const chatId = extra.from;

      // ── 1. Owner contact card (UNCHANGED) ──────────────────────────────────
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName : [config.ownerName];
      const vCards = config.ownerNumber.map((num, index) => {
        const name = ownerNames[index] || ownerNames[0] || 'Bot Owner';
        return {
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;waid=${num}:${num}\nEND:VCARD`
        };
      });

      const displayName = ownerNames[0] || config.ownerName || 'Bot Owner';

      await sock.sendMessage(chatId, {
        contacts: {
          displayName: displayName,
          contacts: vCards
        }
      });

      // ── 2. "He is my owner" message (quoted to user) ───────────────────────
      await sock.sendMessage(chatId, {
        text: '👑 *assalamu alaikum*🤝'
      }, { quoted: msg });

      // ── 3. Video (TikTok URL → fallback to hosted MP4) ─────────────────────
      let videoBuffer = null;

      // Attempt 1: TikTok short link
      try {
        videoBuffer = await downloadVideoBuffer(TIKTOK_URL);
      } catch (_) {
        // TikTok redirects to HTML — expected; try fallback
      }

      // Attempt 2: Reliable public MP4
      if (!videoBuffer) {
        try {
          videoBuffer = await downloadVideoBuffer(FALLBACK_VIDEO_URL);
        } catch (_) {
          // If even this fails, videoBuffer stays null
        }
      }

      if (videoBuffer) {
        // Send downloaded buffer
        await sock.sendMessage(chatId, {
          video: videoBuffer,
          caption: VIDEO_CAPTION,
          mimetype: 'video/mp4'
        }, { quoted: msg });
      } else {
        // Last resort: let Baileys/WhatsApp servers try the URL directly
        try {
          await sock.sendMessage(chatId, {
            video: { url: TIKTOK_URL },
            caption: VIDEO_CAPTION,
            mimetype: 'video/mp4'
          }, { quoted: msg });
        } catch (_) {
          // Nothing more we can do — skip the video silently
        }
      }

    } catch (error) {
      console.error('Owner command error:', error.message);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
        
