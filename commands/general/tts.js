const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function ttsCommand(sock, chatId, text, message, language = 'en') {
    if (!text) {
        await sock.sendMessage(chatId, {
            text: '🗣️ Usage: *.tts <text>*\nExample: .tts Hello World'
        }, { quoted: message });
        return;
    }

    const tmpDir = os.tmpdir();
    const fileName = `tts-${Date.now()}.mp3`;
    const filePath = path.join(tmpDir, fileName);

    try {
        await new Promise((resolve, reject) => {
            const gtts = new gTTS(text, language);
            gtts.save(filePath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const audioBuffer = fs.readFileSync(filePath);
        await sock.sendMessage(chatId, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false
        }, { quoted: message });

    } catch (err) {
        console.error('[TTS] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: '❌ Error generating TTS audio. Please try again.'
        }, { quoted: message });
    } finally {
        try { fs.unlinkSync(filePath); } catch (_) {}
    }
}

module.exports = ttsCommand;
