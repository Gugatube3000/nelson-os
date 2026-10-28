// Update to the latest version from GitHub and restart. Data is untouched (it lives outside this folder).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT } from './lib/system.mjs';
import { PORT } from '../server/paths.js';

const run = (cmd, args) => spawnSync(cmd, args, { cwd: APP_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('\nUpdating Nelson OS…\n');
if (run('git', ['pull', '--ff-only']).status !== 0) {
  console.error('Could not pull updates. If files were edited in this folder, ask Claude or Codex to resolve it.');
  process.exit(1);
}
if (run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund']).status !== 0) {
  console.error('Components could not be installed. The running app has been kept open. Fix the connection and run the update again.');
  process.exit(1);
}
try {
  await fetch(`http://localhost:${PORT}/api/system/quit`, { method: 'POST', headers: { 'X-Requested-With': 'nelson-os' } });
  await new Promise((r) => setTimeout(r, 1500));
} catch { /* wasn't running */ }
if (run(process.execPath, [path.join(APP_ROOT, 'scripts', 'launch.mjs')]).status !== 0) {
  console.error('The update downloaded, but Nelson OS did not restart. Check the server log.');
  process.exit(1);
}
console.log('\n✓ Nelson OS is up to date and running.\n');
