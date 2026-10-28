import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function validateBackup(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'nelson-os-backup' || manifest.version !== 1) throw new Error('This is not a supported Nelson OS backup.');
  const file = path.join(root, 'nelson-os.db');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== manifest.databaseSha256) throw new Error('The backup database checksum does not match. Nothing has been restored.');
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('The backup database is damaged.');
  } finally { check.close(); }
  if (fs.existsSync(path.join(root, 'vault.enc')) && !['vault.key', 'vault.key.plain'].some((key) => fs.existsSync(path.join(root, key))) && process.platform !== 'darwin') throw new Error('The backup is missing its sign-in encryption key.');
  return manifest;
}

// Call only after the app is stopped and a snapshot of the current data exists.
export function restoreBackup(directory, targetDirectory) {
  const manifest = validateBackup(directory);
  const source = path.resolve(directory);
  const target = path.resolve(targetDirectory);
  if (source === target || target === path.parse(target).root) throw new Error('Choose the Nelson OS data folder as the restore destination.');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['nelson-os.db-wal', 'nelson-os.db-shm', 'vault.enc', 'vault.key', 'vault.key.plain', 'no-open-on-startup', 'procore-tokens.json']) {
    const file = path.resolve(target, name);
    if (path.dirname(file) !== target) throw new Error('Invalid restore path.');
    fs.rmSync(file, { force: true });
  }
  for (const name of ['nelson-os.db', 'files', 'vault.enc', 'vault.key', 'vault.key.plain', 'no-open-on-startup', 'procore-tokens.json']) {
    const file = path.join(source, name);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(target, name), { recursive: true });
  }
  const restored = new DatabaseSync(path.join(target, 'nelson-os.db'));
  try {
    const oldFiles = path.resolve(manifest.sourceDataDir, 'files') + path.sep;
    for (const doc of restored.prepare('SELECT id, path FROM documents').all()) {
      if (doc.path && path.resolve(doc.path).startsWith(oldFiles)) {
        const relocated = path.join(target, 'files', path.relative(oldFiles, doc.path));
        restored.prepare('UPDATE documents SET path = ? WHERE id = ?').run(relocated, doc.id);
      }
    }
  } finally { restored.close(); }
  return { restored: true, createdAt: manifest.createdAt };
}
