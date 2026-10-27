// One-command install, used by the paste-in prompt and the double-click installers.
//   node scripts/setup.mjs                 install everything and open the setup wizard
//   node scripts/setup.mjs --no-shortcuts  skip start-on-sign-in and the desktop shortcut
//   node scripts/setup.mjs --no-mcp        skip registering with Claude Code / Codex / Claude Desktop
//   node scripts/setup.mjs --no-start      don't start or open the app
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT, installShortcuts, registerMcp } from './lib/system.mjs';

const args = new Set(process.argv.slice(2));
const say = (m) => console.log(`  ${m}`);
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

console.log('\nNelson OS setup\n');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) fail(`Node.js 22.13 or newer is required (found ${process.versions.node}). Install the LTS version from https://nodejs.org and run this again.`);
say(`✓ Node.js ${process.versions.node}`);

if (!fs.existsSync(path.join(APP_ROOT, 'node_modules', 'express'))) {
  say('Installing components (about a minute)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail('npm install failed. Check the internet connection and run this again.');
}
say('✓ Components installed');

if (!args.has('--no-shortcuts')) {
  try {
    installShortcuts({ startup: true, desktop: true, menu: true });
    say('✓ Starts automatically when you sign in');
    say('✓ "Nelson OS" shortcut added to the desktop');
  } catch (err) {
    say(`! Could not create shortcuts: ${err.message}`);
  }
}

if (!args.has('--no-mcp')) {
  const { resolveBin } = await import('../server/ai/cli.js');
  const result = registerMcp({ claudeBin: resolveBin('claude'), codexBin: resolveBin('codex') });
  const names = { claudeCode: 'Claude Code', codex: 'Codex', claudeDesktop: 'Claude Desktop' };
  for (const [k, v] of Object.entries(result)) say(`${String(v).startsWith('registered') ? '✓' : '!'} ${names[k]}: ${v}`);
  if (!Object.keys(result).length) say('· Claude and Codex apps not found; skipped (optional)');
}

if (!args.has('--no-start')) {
  const r = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'launch.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) fail('Nelson OS did not start. See the log in the data folder.');
  say('✓ Nelson OS is running and the setup window is open');
}

console.log(`
  Next: finish in the Nelson OS window (about 5 minutes):
    1. Your name and title
    2. Connect your AI (Claude or ChatGPT): click Connect and sign in
    3. Connect Outlook (read-only)
  Open it any time from the "Nelson OS" icon on the desktop, or http://localhost:4780
`);
