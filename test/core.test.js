import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data folder so tests never touch real data.
process.env.NELSON_OS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-os-test-'));

const { db, ftsQuery, get, list, search } = await import('../server/db.js');
const { loadDemo, clearDemo } = await import('../server/demo.js');
const { computeRisks, submitBy, releaseBy } = await import('../server/domain/risks.js');
const { briefing } = await import('../server/domain/briefing.js');
const { rfiPdf, transmittalPdf, buildEml } = await import('../server/domain/forms.js');
const { rulesTriage } = await import('../server/sync/triage.js');
const { executeTool, stripQuoted } = await import('../server/ai/tools.js');
const { getSecret, setSecret } = await import('../server/secrets.js');

await loadDemo();
// Wait for the sample drawing set to finish indexing.
for (let i = 0; i < 60 && list('documents').some((d) => d.status === 'indexing'); i++) await new Promise((r) => setTimeout(r, 250));

test('overdue RFI risk explains the whole chain it blocks', () => {
  const r = computeRisks().find((x) => x.rule === 'rfi_overdue' && /RFI-002/.test(x.title));
  assert.ok(r, 'RFI-002 risk exists');
  assert.equal(r.severity, 'high');
  const why = r.why.join(' ');
  assert.match(why, /Vinyl windows - shop drawings/);
  assert.match(why, /released for fabrication/);
  assert.match(why, /Window installation/);
  assert.equal(new Set(r.why).size, r.why.length, 'no duplicate lines');
});

test('submittal and order dates work back from the on-site date', () => {
  assert.equal(submitBy({ required_onsite: '2026-12-31', lead_time_days: 21, review_days: 10 }), '2026-11-25');
  assert.equal(releaseBy({ need_by: '2026-12-31', lead_time_days: 14 }), '2026-12-17');
});

test('briefing separates who is waiting on whom', () => {
  const b = briefing();
  assert.ok(b.waitingOnMe.some((w) => w.who === 'Tom Brennan' && w.hasReply));
  assert.ok(b.waitingOnOthers.some((w) => w.type === 'rfis' && w.overdue));
  assert.ok(b.counts.high >= 3);
});

test('RFI form, transmittal and Outlook draft are generated', async () => {
  const rfi = list('rfis').find((r) => r.number === 2);
  const { bytes, filename } = await rfiPdf(rfi.id);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  assert.match(filename, /^RFI-002/);
  const sub = list('submittals')[0];
  assert.equal(Buffer.from((await transmittalPdf(sub.id)).bytes).subarray(0, 5).toString(), '%PDF-');
  const eml = buildEml({ to: [{ name: 'Dana', email: 'dana@example.com' }], subject: 'RFI-002 — test', body: 'Hi', attachments: [{ filename, bytes }] });
  assert.match(eml, /^X-Unsent: 1/);
  assert.match(eml, /Content-Disposition: attachment/);
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
});

test('rules triage: newsletters ignored, questions are on me, my last message waits on them', () => {
  const mk = (from_me, from_email, body) => [{ from_me, from_email, from_name: 'X', body_text: body, to_json: '[{"name":"Dana","email":"d@x.com"}]' }];
  assert.equal(rulesTriage({ subject: 'Weekly news' }, mk(0, 'news@noreply.com', 'Click to unsubscribe')).work_related, false);
  assert.equal(rulesTriage({ subject: 'Vanities' }, mk(0, 'tom@supply.com', 'Can you confirm the counts?')).ball, 'me');
  assert.equal(rulesTriage({ subject: 'RFI-9' }, mk(1, 'me@nelson.com', 'Please see attached RFI.')).ball, 'them');
});

test('quoted replies are stripped from email bodies', () => {
  assert.equal(stripQuoted('Sounds good.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Dana wrote:\n> old text'), 'Sounds good.');
});

test('search covers drawings, logs and email, and is safe with odd input', () => {
  assert.equal(ftsQuery('"); DROP TABLE x; --'), '"drop"* OR "table"*');
  const kinds = new Set(search('vanity').map((h) => h.kind));
  for (const k of ['doc_page', 'takeoffs', 'email']) assert.ok(kinds.has(k), `finds ${k}`);
  const page = db.prepare("SELECT sheet FROM doc_pages WHERE text LIKE '%PLUMBING FIXTURE SCHEDULE%'").get();
  assert.equal(page.sheet, 'P-601');
});

test('agent tools read projects and log what they create', async () => {
  const p = await executeTool('get_project', { project: '88 Fulton' });
  assert.equal(p.project.name, 'Fulton St Townhomes');
  assert.ok(p.submittals.every((s) => 'submit_by' in s));
  const out = await executeTool('create_record', { type: 'rfis', project: 'Fulton', fields: { subject: 'Test question' }, reason: 'test' });
  const rec = get('rfis', out.created.id);
  assert.equal(rec.created_by, 'agent');
  const log = db.prepare('SELECT why FROM activity_log WHERE entity_id = ?').get(rec.id);
  assert.equal(log.why, 'test');
  const draft = await executeTool('draft_email', { to: ['Dana <dana@example.com>'], subject: 'x', body: 'y', attach: [{ type: 'rfi_pdf', id: rec.id }], reason: 'test' });
  assert.match(draft.status, /not been sent/);
});

test('vault encrypts secrets at rest', () => {
  setSecret('test_key', 'sk-ant-secret-value');
  assert.equal(getSecret('test_key'), 'sk-ant-secret-value');
  const raw = fs.readFileSync(path.join(process.env.NELSON_OS_DATA, 'vault.enc'), 'utf8');
  assert.ok(!raw.includes('secret-value'));
});

test('sample data clears completely', () => {
  clearDemo();
  assert.equal(list('projects').length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM threads WHERE id LIKE 'demo-%'").get().n, 0);
});
