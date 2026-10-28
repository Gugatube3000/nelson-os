// End-to-end: the real Outlook and Procore sync code against simulated Microsoft 365 and
// Procore services that behave like the real ones (token refresh, paging, folders, detail calls).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toLocaleDateString('en-CA');

// ---------- simulated services ----------
const calls = { graphWrites: [], msRefresh: 0, pcRefresh: 0, pcHeaders: [] };
const pc = { rfis: null, tasks: null };
const msg = (id, conv, folder, fromName, fromEmail, subject, body, daysAgo) => ({
  id, conversationId: conv, parentFolderId: folder, subject, bodyPreview: body.slice(0, 80), body: { content: body },
  from: { emailAddress: { name: fromName, address: fromEmail } }, toRecipients: [{ emailAddress: { name: 'Jonathan', address: 'jonathan@nelsongc.com' } }],
  ccRecipients: [], receivedDateTime: iso(-daysAgo), sentDateTime: iso(-daysAgo), hasAttachments: false, webLink: 'https://outlook.office.com/x', importance: 'normal',
});
const MESSAGES = [
  msg('m1', 'c1', 'f-inbox', 'Tom Brennan', 'tom@baystatesupply.example', 'Vanity quantities for 88 Fulton St', 'Can you confirm the vanity counts so we can lock pricing?', 2),
  msg('m2', 'c2', 'f-fulton', 'Dana Whitfield', 'dana@harborline.example', 'RFI-012 window heights - Fulton St Townhomes', 'We are reviewing RFI-012 and will answer this week.', 3),
  { ...msg('m3', 'c2', 'f-sentitems', 'Jonathan', 'jonathan@nelsongc.com', 'RE: RFI-012 window heights - Fulton St Townhomes', 'Thanks Dana, the window order is waiting on this.', 1), toRecipients: [{ emailAddress: { name: 'Dana Whitfield', address: 'dana@harborline.example' } }] },
  msg('m4', 'c4', 'f-junkemail', 'Prize Desk', 'win@spam.example', 'You won a prize', 'Click here', 1),
  msg('m5', 'c5', 'f-deleteditems', 'Old Vendor', 'old@vendor.example', 'Old thread', 'Old message', 4),
  msg('m6', 'c6', 'f-inbox', 'Builder Weekly', 'news@builderweekly.example', 'Lumber prices this week', 'Market update. Unsubscribe anytime.', 1),
];

function resetProcore() {
  pc.rfis = [
    { id: 1001, number: '12', subject: 'Window head heights at rear elevation', status: 'open', due_date: ymd(-5), initiated_at: iso(-12), assignees: [{ name: 'Dana Whitfield', login: 'dana@harborline.example' }] },
    { id: 1002, number: '11', subject: 'Stair stringer bearing', status: 'closed', questions: [{ body: 'Hanger type?', answers: [{ body: 'Use LSU26', official: true, created_at: iso(-20) }] }] },
    { id: 1003, number: '13', subject: 'Shower niche blocking', status: 'open', due_date: ymd(6), questions: [{ body: 'Confirm niche framing.' }] },
  ];
  pc.tasks = [
    { id: 3001, task_name: 'Building envelope', has_children: true, start_datetime: iso(-5), finish_datetime: iso(30), percentage: 10 },
    { id: 3002, task_name: 'Window installation', has_children: false, start_datetime: iso(10), finish_datetime: iso(15), percentage: 0, resource_name: 'Ortega Framing' },
    { id: 3003, task_name: 'Demolition', has_children: false, start_datetime: iso(-90), finish_datetime: iso(-60), percentage: 100 },
  ];
}

let server;
let base;
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

function handle(req, res) {
  const url = new URL(req.url, base);
  const p = url.pathname;
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    // Microsoft identity platform
    if (p === '/ms-login/common/oauth2/v2.0/token') {
      if (new URLSearchParams(body).get('grant_type') === 'refresh_token') calls.msRefresh++;
      return send(res, 200, { access_token: 'ms-access', refresh_token: 'ms-refresh-2', expires_in: 3600, scope: 'User.Read Mail.Read Calendars.Read' });
    }
    // Microsoft Graph (read only; any write is recorded as a violation)
    if (p.startsWith('/v1.0/')) {
      if (req.method !== 'GET' && p !== '/v1.0/search/query') { calls.graphWrites.push(`${req.method} ${p}`); return send(res, 405, {}); }
      if (req.headers.authorization !== 'Bearer ms-access') return send(res, 401, { error: { message: 'bad token' } });
      if (p === '/v1.0/me') return send(res, 200, { displayName: 'Jonathan', mail: 'jonathan@nelsongc.com' });
      const folder = p.match(/^\/v1\.0\/me\/mailFolders\/([a-z]+)$/);
      if (folder) return folder[1] === 'conversationhistory' ? send(res, 404, { error: { message: 'not found' } }) : send(res, 200, { id: `f-${folder[1]}` });
      if (p === '/v1.0/me/messages') {
        if (url.searchParams.get('$skiptoken')) return send(res, 200, { value: MESSAGES.slice(3) });
        if (!/^receivedDateTime ge /.test(url.searchParams.get('$filter') || '')) return send(res, 400, { error: { message: 'missing date filter' } });
        return send(res, 200, { value: MESSAGES.slice(0, 3), '@odata.nextLink': `${base}/v1.0/me/messages?$skiptoken=2` });
      }
      if (p === '/v1.0/me/calendarView') return send(res, 200, { value: [{ id: 'ev1', subject: 'OAC meeting - Fulton St Townhomes', start: { dateTime: `${ymd(1)}T09:00:00` }, end: { dateTime: `${ymd(1)}T10:00:00` }, location: { displayName: '88 Fulton St' }, organizer: { emailAddress: { name: 'Jonathan' } } }] });
      return send(res, 404, { error: { message: `no route ${p}` } });
    }
    // Procore
    if (p === '/pc-login/oauth/token') { calls.pcRefresh++; return send(res, 200, { access_token: 'pc-access', refresh_token: `pc-refresh-${calls.pcRefresh}`, expires_in: 5400, created_at: Math.floor(Date.now() / 1000) }); }
    if (p.startsWith('/pc-api/')) {
      if (req.method !== 'GET') return send(res, 405, {});
      if (req.headers.authorization !== 'Bearer pc-access') return send(res, 401, {});
      calls.pcHeaders.push(req.headers['procore-company-id']);
      if (p === '/pc-api/rest/v1.0/projects') return send(res, 200, [{ id: 555, name: 'Fulton St Townhomes', display_name: 'Fulton St Townhomes', address: '88 Fulton St', city: 'Medford', project_number: 'FUL-01' }]);
      if (p === '/pc-api/rest/v1.0/projects/555/rfis') return send(res, 200, pc.rfis.map(({ questions, ...r }) => (r.id === 1001 ? r : { ...r, questions })));
      const detail = p.match(/^\/pc-api\/rest\/v1\.0\/projects\/555\/rfis\/(\d+)$/);
      if (detail) {
        const r = pc.rfis.find((x) => String(x.id) === detail[1]);
        return send(res, 200, { ...r, questions: r.questions || [{ plain_text_body: 'A-201 and the window schedule disagree. Which head height governs?', answers: r.answers || [] }] });
      }
      if (p === '/pc-api/rest/v1.1/projects/555/submittals') return send(res, 200, [{ id: 2001, formatted_number: '08 53 13-1', title: 'Vinyl windows', status: { name: 'Open' }, required_on_site_date: ymd(20), lead_time: 21, responsible_contractor: { name: 'North Shore Windows' }, specification_section: { number: '08 53 13' } }]);
      if (p === '/pc-api/rest/v1.0/tasks') return send(res, 200, pc.tasks);
      return send(res, 404, {});
    }
    send(res, 404, {});
  });
}

let mods;
before(async () => {
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    NELSON_OS_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-os-e2e-')),
    NELSON_OS_GRAPH_URL: `${base}/v1.0`, NELSON_OS_MS_LOGIN: `${base}/ms-login`,
    NELSON_OS_PROCORE_API: `${base}/pc-api`, NELSON_OS_PROCORE_LOGIN: `${base}/pc-login`,
  });
  const db = await import('../server/db.js');
  const secrets = await import('../server/secrets.js');
  const procore = await import('../server/sync/procore.js');
  const mail = await import('../server/sync/mail.js');
  const { briefing } = await import('../server/domain/briefing.js');
  mods = { ...db, ...secrets, procore, mail, briefing };

  db.setSetting('ai.engine', 'none'); // rules only, so no real AI is called
  db.setSetting('microsoft.clientId', 'test-client');
  db.setSetting('microsoft.account', { name: 'Jonathan', email: 'jonathan@nelsongc.com' });
  secrets.setSecret('microsoft_tokens', { access_token: 'expired', refresh_token: 'ms-refresh-1', expires_at: 0 });
  procore.saveApp({ clientId: 'pc-client', clientSecret: 'pc-secret' });
  fs.writeFileSync(procore.TOKEN_PATH, JSON.stringify({ access_token: 'expired', refresh_token: 'pc-refresh-0', expires_at: 0 }));
  db.setSetting('procore.account', { name: 'Jonathan', login: 'jonathan@nelsongc.com' });
  db.setSetting('procore.companies', [{ id: 77, name: 'Nelson Group' }]);
  procore.chooseCompany(77);
  resetProcore();
});
after(() => server.close());

test('Procore import: projects, RFIs (with full question text), submittals and the schedule', async () => {
  const { procore, list, db } = mods;
  const state = await procore.syncProcore();
  assert.equal(state.error, null, state.error);
  assert.ok(calls.pcRefresh >= 1, 'expired Procore token was refreshed');
  assert.ok(calls.pcHeaders.every((h) => h === '77'), 'company header sent on every call');
  const [project] = list('projects');
  assert.equal(project.name, 'Fulton St Townhomes');
  assert.equal(project.procore_id, '555');
  const rfis = Object.fromEntries(list('rfis').map((r) => [r.procore_id, r]));
  assert.equal(rfis['1001'].status, 'sent');
  assert.match(rfis['1001'].question, /head height governs/, 'question filled from the detail call');
  assert.equal(rfis['1002'].status, 'closed');
  assert.equal(list('submittals')[0].status, 'submitted');
  assert.deepEqual(list('schedule_items').map((s) => s.name), ['Window installation'], 'parents and old tasks are skipped');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE kind = 'change'").get().n, 0, 'the first import is summarized, not itemized');
});

test('Outlook import: every folder except junk and deleted, threads, project links and calendar', async () => {
  const { mail, list, get, db } = mods;
  const state = await mail.syncMail({ days: 30 });
  assert.equal(state.error, null, state.error);
  assert.equal(state.fetched, 4, 'inbox, project subfolder, sent and newsletter; junk and deleted skipped');
  assert.deepEqual(calls.graphWrites, [], 'nothing but reads reached Microsoft');
  assert.equal(calls.msRefresh, 1, 'one token refresh shared by all requests');
  const project = list('projects')[0];
  const vanity = get('threads', 'c1');
  assert.equal(vanity.project_id, project.id, 'email matched to the Procore project by address');
  assert.equal(vanity.ball, 'me');
  const rfiThread = get('threads', 'c2');
  assert.equal(rfiThread.ball, 'them', 'last message was Jonathan’s, so it waits on the architect');
  assert.equal(rfiThread.project_id, project.id, 'filed in a project folder and still linked');
  assert.equal(get('threads', 'c6').work, 0, 'newsletter is not work');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM emails WHERE id IN (?, ?)').get('m4', 'm5').n, 0);
  assert.equal(db.prepare('SELECT project_id FROM calendar_events WHERE id = ?').get('ev1').project_id, project.id);
});

test('Today connects Procore and Outlook into one picture', () => {
  const b = mods.briefing();
  const rfiRisk = b.attention.find((r) => r.rule === 'rfi_overdue');
  assert.ok(rfiRisk, 'overdue Procore RFI is flagged');
  assert.match(rfiRisk.title, /RFI-012 is 5 days overdue/);
  assert.ok(b.waitingOnMe.some((w) => w.who === 'Tom Brennan'), 'supplier email waiting on Jonathan');
  assert.ok(b.waitingOnOthers.some((w) => w.type === 'rfis' && w.overdue), 'architect owes the overdue RFI');
  assert.ok(b.lookahead.some((l) => l.title === 'Window installation'));
  assert.ok(b.lookahead.some((l) => l.type === 'calendar'));
});

test('the next sync reports what changed: answers, slips and removed items', async () => {
  const { procore, db, list } = mods;
  const r = pc.rfis.find((x) => x.id === 1001);
  Object.assign(r, { questions: [{ body: 'Which head height governs?', answers: [{ body: 'Use 7 ft 0 in.', official: true, created_at: iso(0) }] }] });
  pc.rfis = pc.rfis.filter((x) => x.id !== 1003);
  pc.tasks.find((t) => t.id === 3002).finish_datetime = iso(20);
  await procore.syncProcore();
  const changes = db.prepare("SELECT title FROM activity_log WHERE kind = 'change'").all().map((c) => c.title);
  assert.ok(changes.some((t) => /RFI-012 .* was answered/.test(t)), changes.join(' | '));
  assert.ok(changes.some((t) => /Window installation" finish slipped 5 days/.test(t)), changes.join(' | '));
  assert.ok(changes.some((t) => /RFI-013 .* no longer in Procore/.test(t)), changes.join(' | '));
  assert.equal(list('rfis').find((x) => x.procore_id === '1003').status, 'void');
  assert.ok(mods.briefing().changes.length >= 3, 'Today shows them');
});
