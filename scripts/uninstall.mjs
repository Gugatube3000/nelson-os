// Remove shortcuts, start-on-sign-in and the Claude/Codex registrations. Keeps project data
// unless --delete-data is passed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { removeShortcuts, runBin } from './lib/system.mjs';
import { DATA_DIR, PORT } from '../server/paths.js';
import { resolveBin } from '../server/ai/cli.js';

try { await fetch(`http://localhost:${PORT}/api/system/quit`, { method: 'POST', headers: { 'X-Requested-With': 'nelson-os' } }); } catch { /* not running */ }
removeShortcuts();
console.log('✓ Removed shortcuts and start-on-sign-in');

const claude = resolveBin('claude');
if (claude) runBin(claude, ['mcp', 'remove', '--scope', 'user', 'nelson-os']);
const codex = resolveBin('codex');
if (codex) runBin(codex, ['mcp', 'remove', 'nelson-os']);
const desktopCfg = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
  : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
try {
  const cfg = JSON.parse(fs.readFileSync(desktopCfg, 'utf8'));
  if (cfg.mcpServers?.['nelson-os']) { delete cfg.mcpServers['nelson-os']; fs.writeFileSync(desktopCfg, JSON.stringify(cfg, null, 2)); }
} catch { /* no Claude Desktop */ }
console.log('✓ Removed from Claude Code, Codex and Claude Desktop');

if (process.argv.includes('--delete-data')) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`✓ Deleted all Nelson OS data in ${DATA_DIR}`);
} else {
  console.log(`Your data is still in ${DATA_DIR} (run with --delete-data to remove it).`);
}
