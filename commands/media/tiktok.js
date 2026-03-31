/**
 * TikTok Downloader — 10 fallback APIs, buffer-verified, retry-safe
 */

const APIs = require('../../utils/api');
const { downloadBuffer, withFallback } = require('../../utils/mediaDownloader');
const config = require('../../config');

const processed = new Set();

module.exports = {
  name: 'tiktok',
  aliases: ['tt', 'ttdl', 'tiktokdl'],
  category: 'media',
  description: 'Download TikTok videos (no watermark)',
  usage: '.tiktok <TikTok URL>',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    try {
      if (processed.has(msg.key.id)) return;
      processed.add(msg.key.id);
      setTimeout(() => processed.delete(msg.key.id), 5 * 60 * 1000);

      const url = args.join(' ').trim();
      if (!url) {
        return await sock.sendMessage(chatId, { text: 'Usage: .tiktok <TikTok URL>' }, { quoted: msg });
      }

      const isTikTok = /tiktok\.com|vm\.tiktok|vt\.tiktok/.test(url);
      if (!isTikTok) {
        return await sock.sendMessage(chatId, { text: '❌ Please provide a valid TikTok link.' }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '🔄', key: msg.key } });

      // ── Try all 10 sources ────────────────────────────────────────────────
      const result = await withFallback(APIs.getTikTokSources(url), 'TikTok');
      const videoUrl = result.videoUrl;
      const title    = result.title || 'TikTok Video';

      if (!videoUrl) throw new Error('No video URL from any source');

      // ── Download buffer with retries ──────────────────────────────────────
      const buffer = await downloadBuffer(videoUrl, {
        headers: { Referer: 'https://www.tiktok.com/' },
        retries: 3
      });

      const caption = `*${title}*\n\n> _Downloaded by ${config.botName}_`;

      await sock.sendMessage(chatId, {
        video:    buffer,
        mimetype: 'video/mp4',
        caption
      }, { quoted: msg });

    } catch (err) {
      console.error('[TIKTOK] Error:', err.message);
      await sock.sendMessage(chatId, {
        text: `❌ TikTok download failed.\n${err.message}`
      }, { quoted: msg });
    }
  }
};
