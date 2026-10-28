// Local snapshots include SQLite's WAL, saved conversations, drawings and the
// encrypted vault/key pair. They are recoverable by the same OS user account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { db, transaction } from './db.js';
import { DATA_DIR } from './paths.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
let running = null;
let lastError = null;
const validName = /^backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/;

function linkTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) linkTree(src, dst);
    else {
      try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    }
  }
}

function snapshots() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((n) => validName.test(n)).sort().reverse();
}

export function backupStatus() {
  const latest = snapshots()[0];
  let createdAt = null;
  try { createdAt = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, latest, 'manifest.json'), 'utf8')).createdAt; } catch { /* no completed snapshot */ }
  return { directory: BACKUP_DIR, latest: latest || null, createdAt, error: lastError };
}

export async function createBackup({ force = false } = {}) {
  if (running) return running;
  const previous = backupStatus();
  if (!force && previous.createdAt && Date.now() - Date.parse(previous.createdAt) < 24 * 3600000) return previous;
  running = (async () => {
    const createdAt = new Date().toISOString();
    const name = `backup-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    const staging = path.join(BACKUP_DIR, `.pending-${name}`);
    fs.mkdirSync(staging, { recursive: true });
    await backup(db, path.join(staging, 'nelson-os.db'));
    // Drawings never change after upload, so snapshots share them through hard links
    // instead of copying gigabytes of PDFs every day.
    linkTree(path.join(DATA_DIR, 'files'), path.join(staging, 'files'));
    for (const entry of ['vault.enc', 'vault.key', 'vault.key.plain', 'no-open-on-startup', 'procore-tokens.json']) {
      const source = path.join(DATA_DIR, entry);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, entry), { recursive: true });
    }
    const check = new DatabaseSync(path.join(staging, 'nelson-os.db'), { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup database verification failed.');
    } finally { check.close(); }
    const databaseSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(staging, 'nelson-os.db'))).digest('hex');
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ format: 'nelson-os-backup', version: 1, createdAt, sourceDataDir: DATA_DIR, databaseSha256 }, null, 2));
    fs.renameSync(staging, path.join(BACKUP_DIR, name));
    // Only prune our own completed, verified snapshot directories.
    const root = path.resolve(BACKUP_DIR) + path.sep;
    for (const old of snapshots().slice(7)) {
      const target = path.resolve(BACKUP_DIR, old);
      if (!target.startsWith(root) || !validName.test(path.basename(target))) throw new Error('Invalid backup cleanup path.');
      const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
      if (manifest.format === 'nelson-os-backup') fs.rmSync(target, { recursive: true });
    }
    lastError = null;
    return backupStatus();
  })().catch((err) => { lastError = err.message; throw err; }).finally(() => { running = null; });
  return running;
}

// Portable data export. Credentials are deliberately excluded; local snapshots
// above preserve encrypted sign-ins, while this file is safe to move between PCs.
export function exportData(version) {
  return transaction(() => {
    const out = { exported_at: new Date().toISOString(), format: 'nelson-os-data', version };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%'").all();
    for (const { name } of tables) {
      if (!/^[a-z_]+$/.test(name)) continue;
      if (name === 'settings') out[name] = db.prepare("SELECT key, value FROM settings WHERE key <> 'phone.passcode'").all();
      else out[name] = db.prepare(`SELECT * FROM ${name}`).all();
    }
    out.includes = 'Onboarding, profile, settings, conversations and indexed data. Drawing PDFs and encrypted sign-ins are in the local automatic snapshots.';
    return out;
  });
}
