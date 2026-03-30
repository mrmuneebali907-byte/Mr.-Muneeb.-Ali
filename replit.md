# Mr. Muneeb Ali Bot — WhatsApp MD Bot Panel

## Overview
A full-featured WhatsApp MD-style multi-command bot built with the Baileys library (Node.js), with a **web panel** for managing up to 50 independent bot sessions. Connect via QR code or pairing code.

## Architecture
- **Runtime**: Node.js 20
- **Main entry**: `index.js`
- **Package manager**: npm
- **Panel server**: `panel/server.js` (Express + Socket.IO on port 5000)
- **Session manager**: `panel/sessionManager.js` (manages up to 50 WhatsApp sessions)

## Key Files
- `index.js` — Main entry point; starts the web panel and optionally bootstraps from SESSION_ID
- `config.js` — Bot configuration (owner number, prefix, bot name, session ID, etc.)
- `handler.js` — Message/command handler (supports per-session owner recognition)
- `database.js` — JSON-based flat-file database for group settings, users, warnings
- `panel/server.js` — Express + Socket.IO web panel server
- `panel/sessionManager.js` — Manages up to 50 independent WhatsApp bot sessions
- `panel/public/` — Web panel UI (index.html, style.css, app.js)
- `commands/` — Modular command folders (admin, ai, anime, fun, generalmedia, owner, textmaker, utility, general, media)
- `utils/` — Helper utilities (api.js, cleanup.js, sticker.js, stickerConverter.js, etc.)
- `sessions/` — Session storage folder (each session: sessions/session_N/creds.json)

## Database
- Uses JSON files in `./database/` directory (groups.json, users.json, warnings.json, mods.json)
- No external database required

## Running
- **Workflow**: `Start application` runs `node index.js` as a webview workflow on port 5000
- Panel opens at port 5000 — use "Add Session" to create bot sessions
- Each session can connect via QR code or pairing code
- Sessions auto-restart on disconnection

## Panel Features
- **Up to 50 independent bot sessions** — each with own phone number and owner
- **QR Code connection** — scan with WhatsApp app
- **Pairing Code connection** — enter phone number to get 8-digit code
- **Real-time status** — Socket.IO updates, live QR refresh
- **Session persistence** — sessions survive server restarts
- **Per-session owner** — each session has its own owner number for command permissions

## Configuration
- `config.sessionID` — Set via `SESSION_ID` environment variable for headless login
- `config.ownerNumber` — Default WhatsApp number(s) of the bot owner (each session can override this)
- `config.prefix` — Command prefix (default: `.`)
- `config.botName` — Bot display name

## APIs Used
- AI Chat: Pollinations.ai (free, no key) → siputzx.my.id fallback → shizo.top fallback
- Weather: wttr.in (free) → Open-Meteo (free)
- Translate: Google Translate free endpoint → MyMemory → dreaded.site
- YouTube/TikTok/Instagram: Multiple free API providers with fallbacks
- Sticker: FFmpeg (ffmpeg-static) + wa-sticker-formatter + node-webpmux

## Fixed Issues
- list.js syntax error (malformed button object) — fixed
- ffmpeg path not set in stickerConverter.js — fixed
- wa-sticker-formatter package installed
- Owner recognition now per-session (uses session's ownerNumber first)
- Weather API updated to free APIs (no key required)
- AI API has multiple reliable fallbacks
