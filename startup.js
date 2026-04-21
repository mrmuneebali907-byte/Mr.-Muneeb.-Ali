/**
 * WATCHDOG — Bot never dies
 *
 * Spawns index.js as a child process.
 * RESTART codes:
 *   exit(0)  → clean stop (Replit shutdown etc.) — watchdog also stops
 *   exit(42) → intentional restart (.restart cmd) — watchdog relaunches immediately
 *   any other code/signal → crash — watchdog relaunches after RESTART_DELAY_MS
 */

const { spawn } = require('child_process');

const RESTART_DELAY_MS  = 3000;   // wait 3 s after a crash before restart
const RESTART_EXIT_CODE = 42;     // used by .restart command — fast relaunch
let   restartCount      = 0;

function launchBot() {
  restartCount++;
  if (restartCount > 1) {
    console.log(`\n[WATCHDOG] 🔄 Restart #${restartCount - 1} — bot coming back up...\n`);
  } else {
    console.log('[WATCHDOG] 🚀 Launching bot...');
  }

  // Pass --max-old-space-size so Node never exceeds 1 GB heap (avoids OOM on long uptime)
  const child = spawn(process.execPath, ['--max-old-space-size=1024', '--expose-gc', 'index.js'], {
    stdio : 'inherit',
    env   : process.env,
    cwd   : __dirname,
  });

  child.on('exit', (code, signal) => {
    if (code === 0) {
      // Replit / OS requested a real stop — honour it
      console.log('[WATCHDOG] Bot exited cleanly (exit 0). Watchdog stopping.');
      process.exit(0);
    }

    if (code === RESTART_EXIT_CODE) {
      // .restart command — fast relaunch, no delay needed
      console.log('[WATCHDOG] 🔁 Intentional restart requested — relaunching now...');
      setImmediate(launchBot);
      return;
    }

    // Unexpected crash
    console.log(
      `\n[WATCHDOG] ⚠️  Bot crashed (code=${code ?? 'null'}, signal=${signal ?? 'none'}).` +
      ` Restarting in ${RESTART_DELAY_MS / 1000}s...\n`
    );
    setTimeout(launchBot, RESTART_DELAY_MS);
  });

  child.on('error', (err) => {
    console.error('[WATCHDOG] ❌ Failed to spawn bot process:', err.message);
    setTimeout(launchBot, RESTART_DELAY_MS);
  });
}

// Keep watchdog alive even if something weird happens
process.on('uncaughtException', (err) => {
  console.error('[WATCHDOG] Uncaught exception in watchdog itself:', err.message);
});

launchBot();
