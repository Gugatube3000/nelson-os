#!/usr/bin/env node
// Nelson OS MCP server (stdio). Exposes the same tools the in-app agent uses to
// Claude Code, Codex and Claude Desktop. Tools run inside the Nelson OS app over localhost,
// so the app starts automatically if it isn't running.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.NELSON_OS_PORT || 4780;
const BASE = `http://localhost:${PORT}`;
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'nelson-os' };

async function healthy() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'nelson-os';
  } catch {
    return false;
  }
}

async function ensureApp() {
  if (await healthy()) return;
  spawn(process.execPath, [path.join(ROOT, 'scripts', 'launch.mjs'), '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await healthy()) return;
  }
  throw new Error('Nelson OS is not running and could not be started.');
}

const server = new Server({ name: 'nelson-os', version: '1.0.0' }, {
  capabilities: { tools: {} },
  instructions: 'Nelson OS is the construction operations system for Nelson Group (Greater Boston developer and builder). Use these tools to see what needs attention, look up projects, email, drawings, RFIs, submittals, orders, schedules, budgets and permits, and to prepare drafts. Nothing is ever sent from these tools; drafts wait for the user in Nelson OS.',
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureApp();
  const tools = await (await fetch(`${BASE}/api/agent/tools`)).json();
  return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await ensureApp();
  const res = await fetch(`${BASE}/api/agent/tool`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ name: req.params.name, input: req.params.arguments || {} }) });
  const out = await res.json();
  if (!out.ok) return { content: [{ type: 'text', text: out.error || 'Tool failed' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(out.result, null, 1).slice(0, 60000) }] };
});

await server.connect(new StdioServerTransport());
