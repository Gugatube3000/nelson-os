import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NELSON_OS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-os-guard-'));

const { get, insert } = await import('../server/db.js');
const { assertReadOnly, assertReadOnlyScopes, graph } = await import('../server/sync/microsoft.js');
const { TOOLS, executeTool } = await import('../server/ai/tools.js');
const { agentSystemPrompt } = await import('../server/ai/prompts.js');
const { CLAUDE_LOCKDOWN_ENV } = await import('../server/ai/cli.js');
const procore = await import('../server/sync/procore.js');

test('Outlook: every send, reply, forward, move, edit or delete is blocked', () => {
  const blocked = [
    ['POST', '/me/sendMail'],
    ['POST', 'https://graph.microsoft.com/v1.0/me/messages/AAMk=/send'],
    ['POST', '/me/messages/AAMk=/reply'],
    ['POST', '/me/messages/AAMk=/replyAll'],
    ['POST', '/me/messages/AAMk=/forward'],
    ['POST', '/me/messages/AAMk=/createReply'],
    ['POST', '/me/messages/AAMk=/move'],
    ['POST', '/me/messages'],
    ['PATCH', '/me/messages/AAMk='],
    ['DELETE', '/me/messages/AAMk='],
    ['POST', '/me/events'],
    ['GET', '/me/messages/AAMk=/send'],
  ];
  for (const [m, p] of blocked) assert.throws(() => assertReadOnly(m, p), /Blocked/, `${m} ${p}`);
  assert.doesNotThrow(() => assertReadOnly('GET', '/me/mailFolders/inbox/messages?$top=50'));
  assert.doesNotThrow(() => assertReadOnly('POST', '/search/query'));
});

test('Outlook: write permissions are never requested', () => {
  for (const s of ['Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite', 'Files.ReadWrite.All']) assert.throws(() => assertReadOnlyScopes([s]));
  assert.doesNotThrow(() => assertReadOnlyScopes(['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read', 'Files.Read.All']));
});

test('Outlook: a send attempt is refused before any network call', async () => {
  await assert.rejects(graph('/me/sendMail', { method: 'POST', body: { message: {} } }), (err) => err.code === 'SEND_BLOCKED');
});

test('the agent has no tool that sends, replies, forwards or approves', () => {
  for (const t of TOOLS) assert.doesNotMatch(t.name, /send|reply|forward|approve/i, t.name);
  assert.ok(TOOLS.some((t) => t.name === 'procore_request_change'));
  assert.match(agentSystemPrompt(), /never try/);
  assert.equal(CLAUDE_LOCKDOWN_ENV.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

test('Procore changes only create an approval, and only Jonathan can decide it', async () => {
  const p = insert('projects', { name: 'Test Job', address: '1 Main St' });
  const out = await executeTool('procore_request_change', {
    method: 'POST', path: '/rest/v1.0/projects/{project_id}/rfis', path_params: { project_id: '1' },
    body: { rfi: { subject: 'Vanity width', draft: true } }, title: 'Create draft RFI in Procore', notifies: 'No one (draft)', project: 'Test Job', reason: 'test',
  });
  const a = get('approvals', out.approval_id);
  assert.equal(a.status, 'pending');
  assert.equal(a.project_id, p.id);
  assert.match(out.status, /Nothing has changed in Procore/);
  await assert.rejects(procore.decideApproval(a.id, true, { by: 'agent' }), /Only Jonathan/);
  const declined = await procore.decideApproval(a.id, false, { by: 'user' });
  assert.equal(declined.status, 'rejected');
  assert.throws(() => procore.requestChange({ method: 'GET', path: '/rest/v1.0/projects', title: 'x' }), /Only changes need approval/);
});

test('Procore records map onto Nelson OS logs', () => {
  const rfi = procore.mapRfi({
    id: 77, number: '12', subject: 'Header height', status: 'open', due_date: '2026-11-02', initiated_at: '2026-10-20T14:00:00Z',
    assignees: [{ name: 'Dana Whitfield', login: 'dana@arch.example' }], cost_impact: { status: 'tbd' }, schedule_impact: { status: 'yes_unknown' },
    questions: [{ body: '<p>Which head height governs?</p>', answers: [] }],
  }, 'https://app.procore.com', 555);
  assert.equal(rfi.number, 12);
  assert.equal(rfi.status, 'sent');
  assert.equal(rfi.question, 'Which head height governs?');
  assert.equal(rfi.date_required, '2026-11-02');
  assert.equal(rfi.schedule_impact, 'yes');
  assert.equal(rfi.ext_url, 'https://app.procore.com/555/project/rfi/show/77');
  assert.equal(procore.mapRfi({ id: 1, status: 'open', questions: [{ answers: [{ body: 'Use 7 ft', official: true, created_at: '2026-10-25T10:00:00Z' }] }] }, '', 1).status, 'answered');

  const sub = procore.mapSubmittal({ id: 9, formatted_number: '08 53 13-1', title: 'Windows', status: { name: 'Revise and Resubmit' }, required_on_site_date: '2026-12-01', lead_time: 21, responsible_contractor: { name: 'North Shore' }, specification_section: { number: '08 53 13' } }, 'https://app.procore.com', 555);
  assert.equal(sub.status, 'revise_resubmit');
  assert.equal(sub.lead_time_days, 21);
  assert.equal(sub.supplier, 'North Shore');

  const task = procore.mapTask({ id: 3, task_name: 'Framing', start_datetime: '2026-10-01T12:00:00Z', finish_datetime: '2026-10-30T12:00:00Z', percentage: 60, resource_name: 'Ortega' }, '', 1);
  assert.deepEqual([task.start, task.finish, task.status, task.responsible], ['2026-10-01', '2026-10-30', 'in_progress', 'Ortega']);
});
