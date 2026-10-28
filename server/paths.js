import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();

// Windows silently redirects files that packaged apps (the Codex and Claude desktop apps)
// create under AppData into a private per-app copy. A Nelson OS started from one of those
// apps would then see different data than one started from the desktop icon. Keeping data
// in the user's profile folder avoids that, so every launch sees the same data.
function defaultDataDir() {
  if (process.env.NELSON_OS_DATA) return path.resolve(process.env.NELSON_OS_DATA);
  if (process.platform === 'win32') return path.join(home, '.nelson-os');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'NelsonOS');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'nelson-os');
}

// User data lives outside the repo so `git pull` updates never touch it.
export const DATA_DIR = defaultDataDir();
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

// ---------- one-time move from the old Windows location ----------
function legacyDirs() {
  if (process.platform !== 'win32' || process.env.NELSON_OS_DATA) return [];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dirs = [path.join(local, 'NelsonOS')];
  try {
    for (const pkg of fs.readdirSync(path.join(local, 'Packages'))) dirs.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Local', 'NelsonOS'));
  } catch { /* no packaged apps */ }
  return dirs.filter((d) => fs.existsSync(path.join(d, 'nelson-os.db')));
}

function describe(dir) {
  const mtime = Math.max(...['nelson-os.db', 'nelson-os.db-wal'].map((f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } }));
  let score = 0;
  try {
    const db = new DatabaseSync(path.join(dir, 'nelson-os.db'), { readOnly: true });
    try {
      const setup = db.prepare("SELECT value FROM settings WHERE key = 'setup.complete'").get()?.value === 'true';
      const rows = ['projects', 'threads', 'chats', 'rfis'].reduce((n, t) => { try { return n + db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return n; } }, 0);
      score = (setup ? 1e6 : 0) + rows;
    } finally { db.close(); }
  } catch { /* unreadable copy */ }
  return { dir, mtime, score };
}

function migrateLegacyData() {
  if (fs.existsSync(path.join(DATA_DIR, 'nelson-os.db'))) return;
  const candidates = legacyDirs().map(describe).filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const source = candidates[0];
  if (!source) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // VACUUM INTO writes a consistent copy that includes anything still in the WAL file.
  const src = new DatabaseSync(path.join(source.dir, 'nelson-os.db'), { readOnly: true });
  try { src.exec(`VACUUM INTO '${path.join(DATA_DIR, 'nelson-os.db').replace(/'/g, "''")}'`); } finally { src.close(); }
  // Encrypted sign-ins only work with the key they were written with, so they move as a set.
  for (const name of ['files', 'vault.enc', 'vault.key', 'vault.key.plain', 'procore-tokens.json', 'no-open-on-startup']) {
    const from = path.join(source.dir, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(DATA_DIR, name), { recursive: true, errorOnExist: false });
  }
  const db = new DatabaseSync(path.join(DATA_DIR, 'nelson-os.db'));
  try {
    for (const doc of db.prepare('SELECT id, path FROM documents').all()) {
      const rel = relativeDocPath(doc.path);
      if (rel !== doc.path) db.prepare('UPDATE documents SET path = ? WHERE id = ?').run(rel, doc.id);
    }
  } catch { /* older database without documents */ } finally { db.close(); }
  const note = `Moved to ${DATA_DIR} on ${new Date().toISOString()} from ${source.dir}`;
  fs.writeFileSync(path.join(DATA_DIR, 'MIGRATED-FROM.txt'), `${note}\nOther copies found: ${candidates.slice(1).map((c) => c.dir).join(', ') || 'none'}\n`);
  try { fs.writeFileSync(path.join(source.dir, 'MOVED-TO.txt'), `${note}\nThis folder is no longer used and can be deleted after checking Nelson OS.\n`); } catch { /* read-only */ }
  console.log(`[data] ${note}`);
}

/** Store drawing paths relative to the files folder so data folders can move. */
export function relativeDocPath(p) {
  if (!p || !path.isAbsolute(p)) return p;
  const m = String(p).match(/[\\/](?:NelsonOS|nelson-os|\.nelson-os)[\\/]files[\\/](.+)$/i);
  return m ? m[1].split(/[\\/]/).join(path.sep) : p;
}

export function resolveDocPath(p) {
  if (!p) return p;
  if (!path.isAbsolute(p)) return path.join(FILES_DIR, p);
  if (fs.existsSync(p)) return p;
  return path.join(FILES_DIR, relativeDocPath(p));
}

try { migrateLegacyData(); } catch (err) { console.error('[data] could not move data from the old location:', err.message); }
for (const dir of [DATA_DIR, FILES_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

// config/local.json (gitignored) overrides config/defaults.json.
export const CONFIG = merge(
  readJson(path.join(APP_ROOT, 'config', 'defaults.json')),
  readJson(path.join(APP_ROOT, 'config', 'local.json')),
);

export const PORT = Number(process.env.NELSON_OS_PORT || CONFIG.port || 4780);
export const BASE_URL = `http://localhost:${PORT}`;
