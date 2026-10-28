// Keeps the Nelson OS server running. Restarts it if it crashes or stops answering,
// backs off if it keeps failing, and exits cleanly when the server is asked to quit.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, DATA_DIR, LOG_DIR, PORT } from '../server/paths.js';
import { cleanEnv } from '../server/ai/cli.js';

const LOCK = path.join(DATA_DIR, 'supervisor.pid');
const SERVER = path.join(APP_ROOT, 'server', 'index.js');
const LOG = path.join(LOG_DIR, 'server.log');
const log = (m) => { try { fs.appendFileSync(LOG, `[supervisor ${new Date().toISOString()}] ${m}\n`); } catch { /* disk full */ } };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function healthy() {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) });
    return (await r.json()).app === 'nelson-os';
  } catch { return false; }
}

// One supervisor per data folder. A previous one that is shutting down gets a few seconds.
for (let i = 0; i < 16; i++) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(LOCK, 'utf8')); } catch { /* none */ }
  if (!pid || pid === process.pid || !alive(pid)) break;
  if (i === 15) process.exit(0);
  await new Promise((r) => setTimeout(r, 500));
}
fs.writeFileSync(LOCK, String(process.pid));
const release = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch { /* gone */ } };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child?.kill(); process.exit(0); });

let child = null;
let restarts = [];
let killedForHang = false;

function start() {
  try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, `${LOG}.old`); } catch { /* no log yet */ }
  const out = fs.openSync(LOG, 'a');
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], { cwd: APP_ROOT, stdio: ['ignore', out, out], windowsHide: true, env: cleanEnv() });
  child.on('exit', (code, signal) => {
    try { fs.closeSync(out); } catch { /* closed */ }
    child = null;
    // 0 = asked to quit (update, uninstall) or another copy is already serving.
    if (code === 0 && !killedForHang) { log('server stopped normally'); process.exit(0); }
    killedForHang = false;
    restarts = [...restarts.filter((t) => Date.now() - t < 10 * 60 * 1000), Date.now()];
    // 3 = the port belongs to a different program; trying every few seconds won't help.
    const delay = code === 3 ? 60000 : restarts.length > 5 ? 60000 : 2000;
    log(`server exited (code ${code ?? signal}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

start();

// Watchdog: a server that stops answering for two minutes is restarted.
let misses = 0;
setInterval(async () => {
  if (!child) return;
  if (await healthy()) { misses = 0; return; }
  if (++misses >= 4) {
    log('server stopped answering; restarting it');
    misses = 0;
    killedForHang = true;
    child.kill();
  }
}, 30000);
