// Run the full agent on a Claude or ChatGPT subscription: the local Claude Code / Codex CLI
// drives the conversation and calls Nelson OS tools through the Nelson OS MCP server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, DATA_DIR, PORT } from '../paths.js';
import { CLAUDE_LOCKDOWN_ENV, codexLockdownArgs, runCli } from './cli.js';
import { toolLabel } from './tools.js';

const WORKDIR = path.join(DATA_DIR, 'agent-workspace');
fs.mkdirSync(WORKDIR, { recursive: true });

export const MCP_SERVER = {
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', path.join(APP_ROOT, 'mcp', 'server.js')],
  env: { NELSON_OS_PORT: String(PORT), NELSON_OS_DATA: DATA_DIR },
};

function mcpConfigFile() {
  const file = path.join(DATA_DIR, 'mcp-config.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'nelson-os': MCP_SERVER } }, null, 2));
  return file;
}

export async function runClaudeAgent({ prompt, sessionId, fallbackPrompt = prompt, onStep }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '40',
    '--mcp-config', mcpConfigFile(), '--strict-mcp-config',
    '--tools', 'Read', '--allowedTools', 'mcp__nelson-os', 'Read'];
  if (sessionId) args.push('--resume', sessionId);
  let result = null;
  let session = sessionId;
  const r = await runCli('claude', args, {
    input: prompt,
    cwd: WORKDIR,
    env: CLAUDE_LOCKDOWN_ENV,
    timeoutMs: 15 * 60 * 1000,
    onLine: (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) session = ev.session_id;
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use') onStep?.({ tool: b.name, label: toolLabel(b.name) });
        }
      }
      if (ev.type === 'result') result = ev;
    },
  });
  if (!result) {
    if (sessionId) return runClaudeAgent({ prompt: fallbackPrompt, sessionId: null, onStep });
    throw new Error(`Claude did not return an answer. ${(r.stderr || '').slice(0, 300)}`);
  }
  if (result.is_error) throw new Error(result.result || 'Claude reported an error.');
  return { text: result.result || '', sessionId: session };
}

export async function runCodexAgent({ prompt, onStep }) {
  const outFile = path.join(os.tmpdir(), `nelson-os-codex-${process.pid}-${Date.now()}.txt`);
  const lit = (s) => JSON.stringify(String(s));
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...(await codexLockdownArgs({ keep: ['nelson-os'] })),
    '-c', `mcp_servers.nelson-os.command=${lit(MCP_SERVER.command)}`,
    '-c', `mcp_servers.nelson-os.args=[${MCP_SERVER.args.map(lit).join(', ')}]`,
    '-c', `mcp_servers.nelson-os.env={ NELSON_OS_PORT = ${lit(String(PORT))}, NELSON_OS_DATA = ${lit(DATA_DIR)} }`,
    '-o', outFile, '-'];
  try {
    const r = await runCli('codex', args, {
      input: prompt,
      cwd: WORKDIR,
      timeoutMs: 15 * 60 * 1000,
      onLine: (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        const item = ev.item || ev.msg || {};
        if ((ev.type === 'item.started' || ev.type === 'mcp_tool_call_begin') && (item.type === 'mcp_tool_call' || item.tool || item.invocation)) {
          const tool = item.tool || item.invocation?.tool || 'tool';
          onStep?.({ tool, label: toolLabel(tool) });
        }
      },
    });
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (!text) throw new Error(`Codex did not return an answer. ${(r.stderr || '').slice(-300)}`);
    return { text };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/** Let Claude Code read local files (drawing pages) and answer. */
export async function askWithLocalAgent({ prompt, readDir }) {
  const r = await runCli('claude', ['-p', '--output-format', 'json', '--max-turns', '15', '--tools', 'Read', '--allowedTools', 'Read',
    '--add-dir', readDir, '--strict-mcp-config', '--no-session-persistence'], { input: prompt, cwd: readDir, env: CLAUDE_LOCKDOWN_ENV, timeoutMs: 10 * 60 * 1000 });
  const start = r.stdout.indexOf('{');
  const out = JSON.parse(r.stdout.slice(start));
  if (out.is_error) throw new Error(out.result || 'Claude could not read the drawings.');
  return out.result || '';
}
