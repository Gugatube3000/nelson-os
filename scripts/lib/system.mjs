// Desktop integration: start on sign-in, desktop/Start-menu shortcuts, and registering the
// Nelson OS MCP server with Claude Code, Codex and Claude Desktop. Windows, macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = 'Nelson OS';
const NODE = process.execPath;
const LAUNCH = path.join(APP_ROOT, 'scripts', 'launch.mjs');
const MCP = path.join(APP_ROOT, 'mcp', 'server.js');
const ICO = path.join(APP_ROOT, 'assets', 'nelson-os.ico');
const PNG = path.join(APP_ROOT, 'assets', 'nelson-os.png');
const home = os.homedir();
const LOCAL = path.join(APP_ROOT, '.local');

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8', windowsHide: true }).trim();
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

let winDirs = null;
function windowsDirs() {
  if (!winDirs) {
    const [desktop, startup, programs] = ps('[Environment]::GetFolderPath("Desktop"); [Environment]::GetFolderPath("Startup"); [Environment]::GetFolderPath("Programs")').split(/\r?\n/);
    winDirs = { desktop, startup, programs };
  }
  return winDirs;
}

function shortcutPaths() {
  if (process.platform === 'win32') {
    const d = windowsDirs();
    return { desktop: path.join(d.desktop, `${NAME}.lnk`), startup: path.join(d.startup, `${NAME}.lnk`), menu: path.join(d.programs, `${NAME}.lnk`) };
  }
  if (process.platform === 'darwin') {
    return { desktop: path.join(home, 'Desktop', `${NAME}.app`), startup: path.join(home, 'Library', 'LaunchAgents', 'com.nelsongroup.nelson-os.plist'), menu: path.join(home, 'Applications', `${NAME}.app`) };
  }
  return { desktop: path.join(home, 'Desktop', 'nelson-os.desktop'), startup: path.join(home, '.config', 'autostart', 'nelson-os.desktop'), menu: path.join(home, '.local', 'share', 'applications', 'nelson-os.desktop') };
}

// ---------- Windows ----------
function windowsLauncher() {
  // A tiny VBScript runs node with no console window. Saved as UTF-16 so any folder name works.
  fs.mkdirSync(LOCAL, { recursive: true });
  const vbs = path.join(LOCAL, 'Nelson OS.vbs');
  const q = (s) => `""${s}""`;
  const body = [
    'Set sh = CreateObject("WScript.Shell")',
    'extra = ""',
    'For Each a In WScript.Arguments: extra = extra & " " & a: Next',
    `sh.Run "${q(NODE)} ${q(LAUNCH)}" & extra, 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
  return vbs;
}

function windowsShortcut(lnk, vbs, args = '') {
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  ps([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)})`,
    `$s.TargetPath = ${psq(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$s.Arguments = ${psq(`"${vbs}"${args ? ` ${args}` : ''}`)}`,
    `$s.WorkingDirectory = ${psq(APP_ROOT)}`,
    `$s.IconLocation = ${psq(`${ICO},0`)}`,
    `$s.Description = ${psq('Nelson OS — construction operations')}`,
    '$s.Save()',
  ].join('; '));
}

// ---------- macOS ----------
function macApp(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const script = `do shell script "${NODE.replace(/"/g, '\\"')} " & quoted form of "${LAUNCH.replace(/"/g, '\\"')}" & " > /dev/null 2>&1 &"`;
  execFileSync('osacompile', ['-o', target, '-e', script]);
  try {
    // Give the app the Nelson icon.
    execFileSync('sips', ['-s', 'format', 'icns', PNG, '--out', path.join(target, 'Contents', 'Resources', 'applet.icns')], { stdio: 'ignore' });
    execFileSync('touch', [target]);
  } catch { /* default icon is fine */ }
}

function macPlist(file) {
  const logDir = path.join(home, 'Library', 'Logs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nelsongroup.nelson-os</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(LAUNCH)}</string><string>--startup</string></array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH || '/usr/bin:/bin')}</string></dict>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'nelson-os.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'nelson-os.log'))}</string>
</dict></plist>
`);
}

// ---------- Linux ----------
function linuxDesktopFile(file, args = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${NAME}\nComment=Construction operations\nExec="${NODE}" "${LAUNCH}"${args ? ` ${args}` : ''}\nIcon=${PNG}\nTerminal=false\nCategories=Office;\n`, { mode: 0o755 });
}

/** Install shortcuts. startup: start Nelson OS when the computer signs in. */
export function installShortcuts({ startup = true, desktop = true, menu = true } = {}) {
  const p = shortcutPaths();
  const done = [];
  if (process.platform === 'win32') {
    const vbs = windowsLauncher();
    if (desktop) { windowsShortcut(p.desktop, vbs); done.push(p.desktop); }
    if (menu) { windowsShortcut(p.menu, vbs); done.push(p.menu); }
    if (startup) { windowsShortcut(p.startup, vbs, '--startup'); done.push(p.startup); }
  } else if (process.platform === 'darwin') {
    if (desktop) { macApp(p.desktop); done.push(p.desktop); }
    if (menu) { macApp(p.menu); done.push(p.menu); }
    if (startup) {
      macPlist(p.startup);
      spawnSync('launchctl', ['unload', p.startup], { stdio: 'ignore' });
      spawnSync('launchctl', ['load', '-w', p.startup], { stdio: 'ignore' });
      done.push(p.startup);
    }
  } else {
    if (desktop) { linuxDesktopFile(p.desktop); done.push(p.desktop); }
    if (menu) { linuxDesktopFile(p.menu); done.push(p.menu); }
    if (startup) { linuxDesktopFile(p.startup, '--startup'); done.push(p.startup); }
  }
  return done;
}

export function removeShortcuts({ startup = true, desktop = true, menu = true } = {}) {
  const p = shortcutPaths();
  if (startup && process.platform === 'darwin' && fs.existsSync(p.startup)) spawnSync('launchctl', ['unload', p.startup], { stdio: 'ignore' });
  for (const [k, file] of Object.entries(p)) {
    if ((k === 'startup' && startup) || (k === 'desktop' && desktop) || (k === 'menu' && menu)) fs.rmSync(file, { recursive: true, force: true });
  }
}

export function shortcutStatus() {
  const p = shortcutPaths();
  return { startup: fs.existsSync(p.startup), desktop: fs.existsSync(p.desktop), menu: fs.existsSync(p.menu), paths: p };
}

// ---------- MCP registration ----------
const MCP_ARGS = ['--disable-warning=ExperimentalWarning', MCP];

function claudeDesktopConfig() {
  const dir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude');
  return { dir, file: path.join(dir, 'claude_desktop_config.json') };
}

export function runBin(bin, args) {
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const r = isCmd
    ? spawnSync([`"${bin}"`, ...args.map(quote)].join(' '), { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** Make Nelson OS tools available inside Claude Code, Codex and Claude Desktop. */
export function registerMcp({ claudeBin, codexBin } = {}) {
  const results = {};
  if (claudeBin) {
    runBin(claudeBin, ['mcp', 'remove', '--scope', 'user', 'nelson-os']);
    const r = runBin(claudeBin, ['mcp', 'add', '--scope', 'user', 'nelson-os', '--', NODE, ...MCP_ARGS]);
    results.claudeCode = r.ok ? 'registered' : `failed: ${r.out.slice(0, 200)}`;
  }
  if (codexBin) {
    runBin(codexBin, ['mcp', 'remove', 'nelson-os']);
    const r = runBin(codexBin, ['mcp', 'add', 'nelson-os', '--', NODE, ...MCP_ARGS]);
    results.codex = r.ok ? 'registered' : `failed: ${r.out.slice(0, 200)}`;
  }
  const cd = claudeDesktopConfig();
  if (fs.existsSync(cd.dir)) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cd.file, 'utf8')); } catch { /* new file */ }
    if (fs.existsSync(cd.file)) fs.copyFileSync(cd.file, `${cd.file}.bak`);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), 'nelson-os': { command: NODE, args: MCP_ARGS } };
    fs.writeFileSync(cd.file, JSON.stringify(cfg, null, 2));
    results.claudeDesktop = 'registered (restart Claude Desktop to load it)';
  }
  return results;
}

export function mcpStatus() {
  const cd = claudeDesktopConfig();
  let desktop = false;
  try { desktop = !!JSON.parse(fs.readFileSync(cd.file, 'utf8')).mcpServers?.['nelson-os']; } catch { /* none */ }
  const codexCfg = path.join(home, '.codex', 'config.toml');
  const codex = fs.existsSync(codexCfg) && /\[mcp_servers\.("?)nelson-os\1\]/.test(fs.readFileSync(codexCfg, 'utf8'));
  const claudeCfg = path.join(home, '.claude.json');
  let claudeCode = false;
  try { claudeCode = !!JSON.parse(fs.readFileSync(claudeCfg, 'utf8')).mcpServers?.['nelson-os']; } catch { /* none */ }
  return { claudeCode, codex, claudeDesktop: desktop, command: [NODE, ...MCP_ARGS] };
}
