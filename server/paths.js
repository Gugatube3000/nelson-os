import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultDataDir() {
  if (process.env.NELSON_OS_DATA) return path.resolve(process.env.NELSON_OS_DATA);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'NelsonOS');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'NelsonOS');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'nelson-os');
}

// User data lives outside the repo so `git pull` updates never touch it.
export const DATA_DIR = defaultDataDir();
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
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
