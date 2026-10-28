// Start Nelson OS in the background if it isn't running, then open it in an app window.
//   node scripts/launch.mjs            start (if needed) and open
//   node scripts/launch.mjs --startup  used at sign-in; opens unless "open on sign-in" is off
//   node scripts/launch.mjs --no-open  start only
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, DATA_DIR, LOG_DIR, PORT } from '../server/paths.js';
import { cleanEnv } from '../server/ai/cli.js';

const URL_BASE = `http://localhost:${PORT}`;
const args = new Set(process.argv.slice(2));

async function healthy() {
  try {
    const res = await fetch(`${URL_BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === 'nelson-os';
  } catch {
    return false;
  }
}

async function startServer() {
  // The supervisor runs the server and restarts it if it ever crashes or hangs.
  spawn(process.execPath, [path.join(APP_ROOT, 'scripts', 'supervisor.mjs')], {
    cwd: APP_ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv(),
  }).unref();
  for (let i = 0; i < 90; i++) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? pf.flatMap((d) => [path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((c) => fs.existsSync(c));
}

function openApp(url) {
  const browser = findBrowser();
  if (browser) {
    // App mode: its own window with no address bar, like a desktop app.
    spawn(browser, [`--app=${url}`, '--window-size=1440,920'], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const running = (await healthy()) || (await startServer());
if (!running) {
  console.error(`Nelson OS did not start. See ${path.join(LOG_DIR, 'server.log')}`);
  process.exit(1);
}
const skipOpen = args.has('--no-open') || (args.has('--startup') && fs.existsSync(path.join(DATA_DIR, 'no-open-on-startup')));
if (!skipOpen) openApp(URL_BASE);
