import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

process.env.NELSON_OS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-http-'));
const { setSetting } = await import('../server/db.js');
setSetting('ai.engine', 'none'); // Deterministic offline tests; never uses a real AI account.

test('HTTP and MCP restart test preserves onboarding, profile, projects and searchable conversations', { timeout: 90000 }, async () => {
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  let server;
  let logs = '';
  const start = async () => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, NELSON_OS_PORT: String(port) } });
    server.stdout.on('data', x => { logs = (logs + x).slice(-2000); });
    server.stderr.on('data', x => { logs = (logs + x).slice(-2000); });
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { if ((await (await fetch(`${base}/api/health`)).json()).ok) return; } catch { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server did not start: ${logs}`);
  };
  const api = async (route, body) => {
    const response = await fetch(`${base}/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nelson-os' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, value.error || route);
    return value;
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const exit = once(server, 'exit');
    await api('/system/quit', {});
    await exit;
  };
  try {
    await start();
    await api('/profile', { name: 'HTTP Tester', title: 'Manager', email: 'test@example.com', signature: 'Custom signature' });
    await api('/profile', { title: 'Director' });
    await api('/setup/progress', { step: 3 });
    assert.equal((await api('/state')).setupStep, 3);
    await stop();
    await start();
    const mid = await api('/state');
    assert.equal(mid.setupComplete, false);
    assert.equal(mid.setupStep, 3);
    await api('/setup/complete', {});
    const tool = await api('/agent/tool', { name: 'create_record', input: { type: 'projects', fields: { name: 'Restart Project' }, reason: 'Isolated persistence test' } });
    assert.ok(tool.ok);
    const projectId = tool.result.created.id;
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nelson-os' }, body: JSON.stringify({ projectId, message: 'Remember the test delivery marker is cobalt.' }) });
    const stream = await response.text();
    assert.match(stream, /event: started/);
    const done = stream.match(/event: done\ndata: ([^\n]+)/);
    assert.ok(done, stream);
    const chatId = JSON.parse(done[1]).chatId;
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nelson-os' }, body: JSON.stringify({ intervalMinutes: 'oops' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/chats/missing`)).status, 404);
    await api('/system/backup', {});
    await stop();
    await start();
    const state = await api('/state');
    assert.equal(state.setupComplete, true);
    assert.equal(state.profile.name, 'HTTP Tester');
    assert.equal(state.profile.title, 'Director');
    assert.equal(state.profile.signature, 'Custom signature');
    assert.ok(state.projects.some(p => p.id === projectId));
    assert.match(JSON.stringify((await api(`/chats/${chatId}`)).display), /cobalt/);
    const hits = await api('/agent/tool', { name: 'search', input: { query: 'cobalt', kinds: ['conversation'] } });
    assert.ok(hits.result.some(h => h.chat_id === chatId));
    const client = new Client({ name: 'reliability-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.resolve('mcp/server.js')], env: { ...process.env, NELSON_OS_PORT: String(port) }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.some(t => t.name === 'read_conversation'));
      const result = await client.callTool({ name: 'read_conversation', arguments: { chat_id: chatId } });
      assert.match(JSON.stringify(result.content), /cobalt/);
    } finally { await client.close(); }
  } finally {
    await stop().catch(() => { if (server && server.exitCode === null) server.kill(); });
  }
});
