// Run the Claude Code and Codex CLIs: find them, install them, sign in, and stream their output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const home = os.homedir();
const binCache = {};

// Drop variables inherited from a parent Claude Code / Codex session (session tokens, proxy URLs)
// so the CLIs use the person's own saved sign-in.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k) || /^ANTHROPIC_(BASE_URL|AUTH_TOKEN)$/i.test(k) || /^CODEX_(SANDBOX|THREAD|SESSION|MANAGED|CI)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

const KNOWN = {
  claude: [path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'), path.join(home, '.claude', 'local', 'claude')],
  codex: [],
  npm: [],
};
const COMMON_DIRS = isWin
  ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), 'C:\\Program Files\\nodejs']
  : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/bin'];

export function resolveBin(name, { refresh = false } = {}) {
  if (!refresh && name in binCache) return binCache[name];
  let found = null;
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    found = isWin ? out.find((p) => /\.exe$/i.test(p)) || out.find((p) => /\.(cmd|bat)$/i.test(p)) : out[0];
  } catch { /* not on PATH */ }
  if (!found) {
    const candidates = [...(KNOWN[name] || []), ...COMMON_DIRS.flatMap((d) => (isWin ? [`${name}.exe`, `${name}.cmd`] : [name]).map((f) => path.join(d, f)))];
    found = candidates.find((c) => fs.existsSync(c)) || null;
  }
  binCache[name] = found;
  return found;
}

const winQuote = (a) => (a === '' ? '""' : /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** Spawn a CLI by name. Windows .cmd shims need a shell; everything else runs directly. */
export function spawnCli(name, args, opts = {}) {
  const bin = resolveBin(name);
  if (!bin) throw Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' });
  const base = { windowsHide: true, cwd: opts.cwd || os.tmpdir(), env: cleanEnv({ NO_COLOR: '1', ...opts.env }), detached: opts.detached };
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    return spawn([`"${bin}"`, ...args.map(winQuote)].join(' '), { ...base, shell: true });
  }
  return spawn(bin, args, base);
}

export function runCli(name, args, { input = '', timeoutMs = 300000, cwd, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnCli(name, args, { cwd, env }); } catch (err) { reject(err); return; }
    let stdout = '';
    let stderr = '';
    let pending = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} took too long and was stopped`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// ---------- no-send lockdown for agent runs ----------
// Inside Nelson OS the AI may only use Nelson OS tools. Claude.ai connectors and any other MCP
// servers the person has installed (an email plugin, for example) are switched off, so the
// agent has no path to send, reply to or forward anything.
export const CLAUDE_LOCKDOWN_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

export async function codexLockdownArgs({ keep = [] } = {}) {
  let servers = [];
  try {
    const r = await runCli('codex', ['mcp', 'list', '--json'], { timeoutMs: 30000 });
    servers = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).map((s) => s.name);
  } catch { /* no servers configured */ }
  const args = [];
  for (const name of servers) {
    if (keep.includes(name)) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Codex has an MCP server named "${name}" that Nelson OS cannot switch off safely. Remove it from Codex, or connect Claude instead.`);
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

// ---------- sign-in status ----------
export async function cliStatus(name) {
  const bin = resolveBin(name, { refresh: true });
  if (!bin) return { installed: false, loggedIn: false };
  try {
    if (name === 'claude') {
      const r = await runCli('claude', ['auth', 'status', '--json'], { timeoutMs: 30000 });
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      return { installed: true, loggedIn: !!j.loggedIn, account: j.email || null, plan: j.subscriptionType || null, method: j.authMethod || null };
    }
    const r = await runCli('codex', ['login', 'status'], { timeoutMs: 30000 });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    return { installed: true, loggedIn, account: null, plan: /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null, method: text.split('\n')[0] };
  } catch (err) {
    return { installed: true, loggedIn: false, error: err.message };
  }
}

// ---------- install ----------
export const jobs = {};
const loginProcs = {};

function job(key) {
  jobs[key] = { key, state: 'running', log: '', url: null, startedAt: Date.now() };
  return jobs[key];
}

function runShell(command, args, j) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: isWin && /^npm$/.test(command), env: cleanEnv() });
    const onData = (d) => { j.log = (j.log + d).slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { j.log += `\n${err.message}`; resolve(1); });
    child.on('close', resolve);
  });
}

export async function installCli(name) {
  const j = job(`install:${name}`);
  let code;
  if (name === 'claude') {
    // Anthropic's official native installer (no admin rights needed).
    code = isWin
      ? await runShell('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], j)
      : await runShell('/bin/bash', ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], j);
  } else {
    code = await runShell('npm', ['install', '-g', '@openai/codex'], j);
    if (code !== 0 && !isWin && resolveBin('brew', { refresh: true })) code = await runShell(resolveBin('brew'), ['install', 'codex'], j);
  }
  const ok = code === 0 && !!resolveBin(name, { refresh: true });
  j.state = ok ? 'done' : 'error';
  if (!ok) j.error = `Could not install ${name === 'claude' ? 'Claude Code' : 'Codex'} automatically.`;
  return j;
}

// ---------- sign in ----------
function openTerminal(name, args) {
  const bin = resolveBin(name);
  if (isWin) {
    spawn('cmd.exe', ['/c', 'start', 'Nelson OS sign-in', 'cmd.exe', '/k', bin, ...args], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  } else if (process.platform === 'darwin') {
    const cmd = [bin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', bin, ...args], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** Start the CLI's browser sign-in. Returns a job the UI polls; the sign-in URL is captured if printed. */
export function startLogin(name) {
  const j = job(`login:${name}`);
  const args = name === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
  let child;
  try {
    child = spawnCli(name, args, {});
  } catch (err) {
    j.state = 'error';
    j.error = err.message;
    return j;
  }
  loginProcs[name] = child;
  const onData = (d) => {
    j.log = (j.log + d).slice(-4000);
    const m = j.log.match(/https:\/\/[^\s"'<>]+/);
    if (m && !j.url) j.url = m[0];
    if (/paste (the )?code/i.test(j.log)) j.acceptsCode = true;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  child.on('close', (code) => {
    const quick = Date.now() - j.startedAt < 4000;
    if (code !== 0 && quick && !j.url) {
      // This CLI wants an interactive terminal; open one so the person can finish there.
      openTerminal(name, args);
      j.state = 'terminal';
    } else j.state = code === 0 ? 'done' : 'error';
  });
  setTimeout(() => { if (j.state === 'running') child.kill(); }, 10 * 60 * 1000);
  return j;
}

/** Some sign-in pages show a code to paste back into the CLI; pass it through. */
export function submitLoginCode(name, code) {
  const child = loginProcs[name];
  if (!child || child.exitCode !== null) throw Object.assign(new Error('The sign-in has ended. Click Connect again.'), { status: 409 });
  child.stdin.write(`${String(code).trim()}\n`);
}
