// Usage: node scripts/restore.mjs "<snapshot folder>". Does not start the app.
import { DATA_DIR, PORT } from '../server/paths.js';
import { validateBackup, restoreBackup } from '../server/recovery.js';

const directory = process.argv[2];
if (!directory) { console.error('Provide a snapshot folder from NelsonOS/backups.'); process.exit(1); }
try {
  validateBackup(directory);
  let running = false;
  try { running = (await (await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) })).json()).app === 'nelson-os'; } catch { /* stopped */ }
  if (running) throw new Error('Close Nelson OS and stop its server before restoring. Also close AI sessions using Nelson OS tools.');
  const { createBackup } = await import('../server/backup.js');
  const { db } = await import('../server/db.js');
  await createBackup({ force: true });
  db.close();
  restoreBackup(directory, DATA_DIR);
  console.log('Backup restored. Open Nelson OS normally. Your previous data was backed up before restoring.');
} catch (err) { console.error(err.message); process.exit(1); }
