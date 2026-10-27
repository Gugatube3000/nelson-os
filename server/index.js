import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { APP_ROOT, CONFIG, DATA_DIR, PORT } from './paths.js';
import { db, ENTITIES, get, getSetting, insert, list, logActivity, now, recentActivity, remove, search, setSetting, today, update } from './db.js';
import { getSecret, setSecret, vaultInfo } from './secrets.js';
import { engineStatus } from './ai/engine.js';
import { jobs as cliJobs } from './ai/cli.js';
import { chat, getChat, listChats } from './ai/agent.js';
import { executeTool, TOOLS, projectDetail, stripQuoted } from './ai/tools.js';
import { profile } from './ai/prompts.js';
import { briefing } from './domain/briefing.js';
import { addDays, computeRisks, dismissRisk, releaseBy, returnDue, submitBy } from './domain/risks.js';
import { REQUIREMENTS, CHECKED } from './domain/requirements.js';
import { buildEml, composeLinks, draftAttachments, rfiNumber, rfiPdf, transmittalPdf } from './domain/forms.js';
import { addDocument, askDrawings, documentPages, extractPage, indexDocument } from './docs/pdf.js';
import * as ms from './sync/microsoft.js';
import { syncMail, syncState } from './sync/mail.js';
import * as procore from './sync/procore.js';
import { suggestReply, triagePending } from './sync/triage.js';
import { clearDemo, hasDemo, loadDemo } from './demo.js';
import { connectCli, connectionStatus, connectMcp, disconnect, saveAnthropicKey, submitLoginCode, useEngine } from './integrations.js';
import { installShortcuts, mcpStatus, removeShortcuts, shortcutStatus } from '../scripts/lib/system.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// ---------- security ----------
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress);

function sessionSecret() {
  let s = getSecret('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSecret('session_secret', s); }
  return s;
}
const sign = (v) => crypto.createHmac('sha256', sessionSecret()).update(v).digest('hex');
function validSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)nos_session=([^;]+)/);
  if (!m) return false;
  const [exp, mac] = decodeURIComponent(m[1]).split('.');
  return Number(exp) > Date.now() && mac && crypto.timingSafeEqual(Buffer.from(mac.padEnd(64, '0').slice(0, 64)), Buffer.from(sign(exp)));
}

app.use((req, res, next) => {
  if (isLocal(req)) {
    // Blocks DNS-rebinding: only accept requests addressed to this computer by name.
    if (!LOCAL_HOSTS.has(String(req.headers.host || '').replace(/:\d+$/, ''))) return res.status(403).send('Forbidden');
    return next();
  }
  if (!getSetting('phone.enabled')) return res.status(403).send('Phone access is off. Turn it on in Nelson OS settings.');
  if (req.path.startsWith('/oauth')) return res.status(403).send('Connect accounts from the computer running Nelson OS.');
  if (req.path.startsWith('/api/') && !['/api/login', '/api/health'].includes(req.path) && !validSession(req)) return res.status(401).json({ error: 'login', message: 'Enter your passcode.' });
  next();
});

// Browsers can't add this header cross-site without permission, so it blocks CSRF on writes.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-requested-with') === 'nelson-os') return next();
  res.status(403).json({ error: 'Missing request header' });
});
app.use(express.json({ limit: '5mb' }));

const longDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nameOf = (id) => (id ? get('projects', id)?.name || null : null);

// ---------- static ----------
app.get('/vendor/htm-preact.mjs', (req, res) => res.type('text/javascript').sendFile(path.join(APP_ROOT, 'node_modules', 'htm', 'preact', 'standalone.mjs')));
app.use(express.static(path.join(APP_ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

// ---------- state ----------
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'nelson-os', version: VERSION }));

app.get('/api/state', wrap(async (req, res) => {
  res.json({
    version: VERSION,
    setupComplete: !!getSetting('setup.complete'),
    profile: profile(),
    company: CONFIG.company,
    engine: await engineStatus(),
    microsoft: ms.status(),
    sync: syncState,
    demo: hasDemo(),
    procore: procore.status(),
    local: isLocal(req),
    projects: list('projects', { status: 'active' }, { order: 'name' }).map((p) => ({ id: p.id, name: p.name, address: p.address, city: p.city, review: p.review, source: p.source })),
  });
}));

app.post('/api/profile', (req, res) => {
  const { name, title, email, phone, signature, company } = req.body || {};
  const p = { ...(getSetting('profile', {}) || {}), name, title, email, phone, company: company || CONFIG.company };
  p.signature = signature || [p.name, p.title, p.company, p.phone].filter(Boolean).join('\n');
  setSetting('profile', p);
  res.json(profile());
});

app.post('/api/setup/complete', (req, res) => {
  setSetting('setup.complete', true);
  logActivity({ actor: 'user', kind: 'setup', title: 'Finished setting up Nelson OS' });
  res.json({ ok: true });
});

// ---------- connections ----------
app.get('/api/connections', wrap(async (req, res) => res.json(await connectionStatus())));

app.post('/api/connections/:id/connect', wrap(async (req, res) => {
  const { id } = req.params;
  if (id === 'claude' || id === 'codex') return res.json({ job: connectCli(id) });
  if (id === 'anthropic') { await saveAnthropicKey(req.body?.apiKey); return res.json({ ok: true }); }
  if (id === 'procore') return res.json({ url: await procore.startAuth({ returnTo: req.body?.returnTo || '/#/connections' }) });
  if (id === 'outlook' || id === 'onedrive') return res.json({ url: ms.authUrl({ files: id === 'onedrive', returnTo: req.body?.returnTo || '/#/connections' }) });
  if (id === 'mcp') return res.json({ result: connectMcp() });
  res.status(400).json({ error: 'This app can’t be connected yet.' });
}));
app.post('/api/connections/:id/code', (req, res) => { submitLoginCode(req.params.id, req.body?.code || ''); res.json({ ok: true }); });
app.get('/api/connections/jobs/:key', (req, res) => res.json(cliJobs[req.params.key] || { state: 'idle' }));
app.post('/api/connections/:id/use', wrap(async (req, res) => res.json(await useEngine(req.params.id))));
app.post('/api/connections/:id/disconnect', wrap(async (req, res) => res.json(await disconnect(req.params.id))));
app.post('/api/connections/procore/app', (req, res) => res.json(procore.saveApp(req.body || {})));
app.post('/api/connections/procore/company', (req, res) => {
  const company = procore.chooseCompany(req.body?.companyId);
  procore.syncProcore().catch(() => {});
  res.json(company);
});
app.post('/api/procore/sync', (req, res) => { procore.syncProcore().catch(() => {}); res.json(procore.syncState); });
app.get('/api/procore/status', (req, res) => res.json(procore.status()));

// ---------- approvals (Procore changes wait here for Jonathan) ----------
app.get('/api/approvals', (req, res) => res.json(list('approvals', { status: req.query.status || 'pending' }).map((a) => ({ ...a, project: nameOf(a.project_id) }))));
app.post('/api/approvals/:id/approve', wrap(async (req, res) => res.json(await procore.decideApproval(req.params.id, true, { by: 'user' }))));
app.post('/api/approvals/:id/decline', wrap(async (req, res) => res.json(await procore.decideApproval(req.params.id, false, { by: 'user' }))));

app.post('/api/connections/microsoft/app', (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return res.status(400).json({ error: 'The Application (client) ID is a 36-character GUID.' });
  setSetting('microsoft.clientId', clientId);
  setSetting('microsoft.tenant', String(req.body?.tenant || 'common').trim() || 'common');
  res.json(ms.status());
});

app.get('/oauth/microsoft/callback', wrap(async (req, res) => {
  try {
    const { returnTo, adminConsented } = await ms.finishAuth(req.query);
    if (adminConsented) {
      logActivity({ actor: 'user', kind: 'connect', title: 'Microsoft 365 admin approved Nelson OS for the company', why: 'One-time admin approval; access stays read-only.' });
      return res.redirect('/#/connections?approved=microsoft');
    }
    logActivity({ actor: 'user', kind: 'connect', title: `Connected Outlook (${ms.status().account?.email})`, why: 'Read-only access to mail and calendar.' });
    if (!getSetting('mail.lastSync')) syncMail({ days: CONFIG.sync?.initialDays || 30 }).catch(() => {});
    res.redirect(`${returnTo || '/'}${(returnTo || '/').includes('?') ? '&' : '?'}connected=outlook`);
  } catch (err) {
    res.redirect(`/#/connections?error=${encodeURIComponent(err.message)}`);
  }
}));

// ---------- sync ----------
app.post('/api/sync/mail', wrap(async (req, res) => {
  if (!ms.status().connected) return res.status(400).json({ error: 'Connect Outlook first.' });
  syncMail({ days: req.body?.days }).catch(() => {});
  res.json(syncState);
}));
app.get('/api/sync/status', (req, res) => res.json(syncState));
app.post('/api/triage/run', wrap(async (req, res) => {
  triagePending({ progress: (done, total) => Object.assign(syncState, { done, total, phase: 'Understanding conversations' }) }).catch(() => {});
  res.json({ ok: true });
}));

// ---------- briefing, risks, search, activity ----------
app.get('/api/briefing', (req, res) => res.json(briefing({ projectId: req.query.project_id || undefined })));
app.get('/api/risks', (req, res) => res.json(computeRisks(req.query.project_id || undefined)));
app.post('/api/risks/dismiss', (req, res) => { dismissRisk(req.body.key, Number(req.body.days) || 7); res.json({ ok: true }); });
app.get('/api/activity', (req, res) => res.json(recentActivity({ projectId: req.query.project_id || undefined, limit: Number(req.query.limit) || 100 }).map((a) => ({ ...a, project: nameOf(a.project_id) }))));
app.get('/api/search', (req, res) => res.json(search(req.query.q, { projectId: req.query.project_id || undefined, limit: 30 }).map((h) => ({ ...h, project: nameOf(h.project_id) }))));
app.get('/api/requirements', (req, res) => res.json({ checked: CHECKED, items: REQUIREMENTS }));

// ---------- records (generic logs) ----------
function withComputed(entity, r) {
  if (entity === 'submittals') return { ...r, submit_by: submitBy(r), return_due: returnDue(r) };
  if (entity === 'orders') return { ...r, release_by: releaseBy(r) };
  return r;
}
app.get('/api/records/:entity', (req, res) => {
  const { entity } = req.params;
  const filters = { ...req.query };
  delete filters.order;
  const order = entity === 'rfis' || entity === 'changes' ? 'number' : entity === 'schedule_items' ? 'start' : undefined;
  res.json(list(entity, filters, { order }).map((r) => ({ ...withComputed(entity, r), project: nameOf(r.project_id) })));
});
app.get('/api/records/:entity/:id', (req, res) => {
  const r = get(req.params.entity, req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(withComputed(req.params.entity, r));
});
app.post('/api/records/:entity', (req, res) => {
  const rec = insert(req.params.entity, { ...req.body, source: 'manual', created_by: 'user', review: 0 });
  logActivity({ actor: 'user', kind: 'create', project_id: rec.project_id || (req.params.entity === 'projects' ? rec.id : null), title: `Added ${req.params.entity.replace(/_/g, ' ').replace(/s$/, '')}: ${rec.subject || rec.title || rec.item || rec.name || rec.kind || ''}`, entity_type: req.params.entity, entity_id: rec.id });
  res.json(withComputed(req.params.entity, rec));
});
app.patch('/api/records/:entity/:id', (req, res) => {
  const body = { ...req.body };
  delete body.id;
  const rec = update(req.params.entity, req.params.id, body);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json(withComputed(req.params.entity, rec));
});
app.post('/api/records/:entity/:id/confirm', (req, res) => {
  const rec = update(req.params.entity, req.params.id, { review: 0 });
  logActivity({ actor: 'user', kind: 'confirm', project_id: rec.project_id, title: `Confirmed ${req.params.entity.replace(/_/g, ' ').replace(/s$/, '')}: ${rec.subject || rec.title || rec.item || rec.name || rec.kind || ''}`, entity_type: req.params.entity, entity_id: rec.id });
  res.json(rec);
});
app.delete('/api/records/:entity/:id', (req, res) => {
  const rec = get(req.params.entity, req.params.id);
  remove(req.params.entity, req.params.id);
  if (rec) logActivity({ actor: 'user', kind: 'delete', project_id: rec.project_id, title: `Removed ${req.params.entity.replace(/_/g, ' ').replace(/s$/, '')}: ${rec.subject || rec.title || rec.item || rec.name || rec.kind || ''}` });
  res.json({ ok: true });
});

// ---------- projects ----------
app.get('/api/projects/:id/overview', (req, res) => {
  const p = get('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ ...projectDetail(p), project: p, activity: recentActivity({ projectId: p.id, limit: 30 }), briefing: briefing({ projectId: p.id }) });
});
app.post('/api/projects/:id/documents', express.raw({ type: () => true, limit: '600mb' }), (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'document.pdf');
  if (!req.body?.length || req.body.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Only PDF files can be added right now.' });
  res.json(addDocument({ projectId: req.params.id, filename, bytes: req.body, kind: req.get('x-kind') || 'drawings' }));
});

// ---------- documents ----------
app.get('/api/documents/:id/file', (req, res) => {
  const d = get('documents', req.params.id);
  if (!d) return res.status(404).end();
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`);
  res.sendFile(d.path);
});
app.get('/api/documents/:id/page/:n', wrap(async (req, res) => {
  const d = get('documents', req.params.id);
  if (!d) return res.status(404).end();
  res.type('application/pdf').send(await extractPage(d.path, Number(req.params.n)));
}));
app.get('/api/documents/:id/pages', (req, res) => res.json(documentPages(req.params.id)));
app.post('/api/documents/:id/reindex', wrap(async (req, res) => res.json(await indexDocument(req.params.id))));
app.post('/api/ask-drawings', wrap(async (req, res) => res.json(await askDrawings(req.body.project_id, req.body.question))));

// ---------- email threads ----------
app.get('/api/threads', (req, res) => {
  const f = { status: req.query.status || 'open', work: req.query.all ? undefined : 1, project_id: req.query.project_id, ball: req.query.ball, category: req.query.category };
  let rows = list('threads', f, { order: 'last_at DESC', limit: 400 });
  if (req.query.q) {
    const ids = new Set(search(req.query.q, { kinds: ['email'], limit: 200 }).map((h) => db.prepare('SELECT thread_id FROM emails WHERE id = ?').get(h.ref_id)?.thread_id));
    rows = rows.filter((t) => ids.has(t.id) || t.subject?.toLowerCase().includes(String(req.query.q).toLowerCase()));
  }
  res.json(rows.map((t) => ({ ...t, project: nameOf(t.project_id) })));
});
app.get('/api/threads/:id', (req, res) => {
  const t = get('threads', req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const emails = db.prepare('SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at').all(t.id).map((e) => ({
    ...e, to: JSON.parse(e.to_json || '[]'), cc: JSON.parse(e.cc_json || '[]'), attachments: JSON.parse(e.attachments_json || '[]'), body: stripQuoted(e.body_text),
  }));
  const related = ['rfis', 'submittals', 'orders', 'changes', 'actions'].flatMap((tbl) => db.prepare(`SELECT id, ${tbl === 'rfis' ? "'RFI-' || printf('%03d', number) || ' ' || subject" : tbl === 'orders' ? 'item' : 'title'} AS label, status, review FROM ${tbl} WHERE thread_id = ?`).all(t.id).map((r) => ({ ...r, type: tbl })));
  res.json({ ...t, project: nameOf(t.project_id), emails, related });
});
app.patch('/api/threads/:id', (req, res) => {
  const allowed = ['status', 'ball', 'project_id', 'category', 'urgency', 'suggested_reply', 'work', 'waiting_on', 'next_action'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const t = update('threads', req.params.id, patch);
  if (patch.project_id) db.prepare('UPDATE emails SET project_id = ? WHERE thread_id = ?').run(patch.project_id, t.id);
  res.json(t);
});
app.post('/api/threads/:id/suggest-reply', wrap(async (req, res) => res.json({ reply: await suggestReply(req.params.id, req.body?.instructions || '') })));
app.post('/api/threads/:id/retriage', wrap(async (req, res) => { await triagePending({ threadIds: [req.params.id] }); res.json(get('threads', req.params.id)); }));
app.post('/api/threads/:id/draft', (req, res) => {
  const t = get('threads', req.params.id);
  const last = db.prepare('SELECT * FROM emails WHERE thread_id = ? AND from_me = 0 ORDER BY received_at DESC LIMIT 1').get(t.id)
    || db.prepare('SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at DESC LIMIT 1').get(t.id);
  const to = last?.from_me ? JSON.parse(last.to_json || '[]') : [{ name: last?.from_name, email: last?.from_email }];
  const draft = insert('drafts', { project_id: t.project_id, to_json: to, cc_json: [], subject: `RE: ${t.subject}`, body: req.body?.body ?? t.suggested_reply ?? '', related_type: 'threads', related_id: t.id, thread_id: t.id, source: 'manual', created_by: 'user' });
  res.json(draft);
});

// ---------- email attachments, OneDrive ----------
app.get('/api/emails/:id/attachments', wrap(async (req, res) => res.json(await ms.listAttachments(req.params.id))));
app.post('/api/emails/:id/attachments/:aid/import', wrap(async (req, res) => {
  const a = await ms.downloadAttachment(req.params.id, req.params.aid);
  if (!/pdf/i.test(a.contentType) && !/\.pdf$/i.test(a.name)) return res.status(400).json({ error: 'Only PDF attachments can be added to a project.' });
  res.json(addDocument({ projectId: req.body.project_id, filename: a.name, bytes: a.bytes, kind: req.body.kind || 'drawings', source: 'email attachment' }));
}));
app.get('/api/onedrive/search', wrap(async (req, res) => res.json(await ms.searchFiles(String(req.query.q || '')))));
app.post('/api/onedrive/import', wrap(async (req, res) => {
  const bytes = await ms.downloadFile(req.body.driveId, req.body.itemId);
  res.json(addDocument({ projectId: req.body.project_id, filename: req.body.name, bytes, kind: req.body.kind || 'drawings', source: 'OneDrive' }));
}));

// ---------- RFIs and submittals: forms and send-ready drafts ----------
const sendPdf = (res, { bytes, filename }) => res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`).send(Buffer.from(bytes));
app.get('/api/rfis/:id/pdf', wrap(async (req, res) => sendPdf(res, await rfiPdf(req.params.id))));
app.get('/api/submittals/:id/transmittal', wrap(async (req, res) => sendPdf(res, await transmittalPdf(req.params.id))));

app.post('/api/rfis/:id/prepare', (req, res) => {
  const r = get('rfis', req.params.id);
  const p = get('projects', r.project_id) || {};
  const me = profile();
  if (!r.date_required) update('rfis', r.id, { date_required: addDays(today(), 7) });
  const due = get('rfis', r.id).date_required;
  const body = `${(r.to_name || '').split(' ')[0] || 'Hello'},\n\nAttached is ${rfiNumber(r)} for ${p.name || 'the project'}: ${r.subject}.\n\n${r.question}\n${r.proposed_solution ? `\nOur proposed solution: ${r.proposed_solution}\n` : ''}\nPlease respond by ${longDate(due)}.${r.schedule_impact === 'yes' ? ' This item is holding up work on site.' : ''}\n\nThank you,\n${me.signature}`;
  const draft = insert('drafts', { project_id: r.project_id, to_json: r.to_email ? [{ name: r.to_name, email: r.to_email }] : [], cc_json: [], subject: `${p.name ? `${p.name} - ` : ''}${rfiNumber(r)} ${r.subject}`, body, attachments_json: [{ type: 'rfi_pdf', id: r.id }], related_type: 'rfis', related_id: r.id, source: 'manual', created_by: 'user' });
  res.json(draft);
});
app.post('/api/submittals/:id/prepare', (req, res) => {
  const s = get('submittals', req.params.id);
  const p = get('projects', s.project_id) || {};
  const me = profile();
  const due = returnDue({ ...s, date_submitted: today() });
  const body = `${(s.reviewer_name || '').split(' ')[0] || 'Hello'},\n\nAttached for your review is submittal ${s.number || ''} (${s.spec_section || ''}) ${s.title}${s.supplier ? ` from ${s.supplier}` : ''}, reviewed by ${me.company}.\n\nPlease return it by ${longDate(due)}.${s.required_onsite ? ` The material is needed on site by ${longDate(s.required_onsite)} and has a ${s.lead_time_days || 0}-day lead time after approval.` : ''}\n\nThank you,\n${me.signature}`;
  const draft = insert('drafts', { project_id: s.project_id, to_json: s.reviewer_email ? [{ name: s.reviewer_name, email: s.reviewer_email }] : [], cc_json: [], subject: `${p.name ? `${p.name} - ` : ''}Submittal ${s.number || ''} ${s.title}`.replace(/\s+/g, ' '), body, attachments_json: [{ type: 'transmittal_pdf', id: s.id }], related_type: 'submittals', related_id: s.id, source: 'manual', created_by: 'user' });
  res.json(draft);
});

// Follow-up for an overdue RFI or submittal (template; the agent writes richer ones).
app.post('/api/followup', (req, res) => {
  const { type, id } = req.body;
  const rec = get(type, id);
  const p = get('projects', rec.project_id) || {};
  const me = profile();
  const isRfi = type === 'rfis';
  const label = isRfi ? rfiNumber(rec) : `submittal ${rec.number || ''} ${rec.title}`;
  const who = isRfi ? { name: rec.to_name, email: rec.to_email } : { name: rec.reviewer_name, email: rec.reviewer_email };
  // Say exactly what is waiting on them, taken from the same chain the risk engine shows.
  const risk = computeRisks(rec.project_id).find((x) => x.key === (isRfi ? `rfi-overdue:${id}` : `sub-review:${id}`));
  const held = (risk?.why || []).slice(1).filter((w) => !/^Current status|^It also depends/.test(w));
  const dueOn = isRfi ? rec.date_required : returnDue(rec);
  const body = `${(who.name || '').split(' ')[0] || 'Hello'},\n\nFollowing up on ${label}${isRfi ? ` (${rec.subject})` : ''} for ${p.name}. It was due back ${longDate(dueOn)}.${held.length ? `\n\nOn our side this is holding up:\n${held.map((h) => `- ${h}`).join('\n')}` : ` ${isRfi ? 'Work downstream is waiting on this answer.' : 'We can’t release fabrication until it is approved.'}`}\n\nCan you get it back to us by ${longDate(addDays(today(), 2))}? If a call is quicker, I'm available today.\n\nThank you,\n${me.signature}`;
  const draft = insert('drafts', { project_id: rec.project_id, to_json: who.email ? [who] : [], subject: `Follow-up: ${p.name ? `${p.name} - ` : ''}${label}`, body, related_type: type, related_id: id, source: 'manual', created_by: 'user' });
  res.json(draft);
});

// ---------- drafts ----------
app.get('/api/drafts', (req, res) => res.json(list('drafts', { status: req.query.status || 'draft', project_id: req.query.project_id }).map((d) => ({ ...d, project: nameOf(d.project_id) }))));
app.get('/api/drafts/:id', (req, res) => {
  const d = get('drafts', req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ ...d, project: nameOf(d.project_id), links: composeLinks({ to: d.to_json, cc: d.cc_json, subject: d.subject, body: d.body }) });
});
app.patch('/api/drafts/:id', (req, res) => {
  const { to_json, cc_json, subject, body } = req.body;
  res.json(update('drafts', req.params.id, { to_json, cc_json, subject, body }));
});
app.delete('/api/drafts/:id', (req, res) => { update('drafts', req.params.id, { status: 'discarded' }); res.json({ ok: true }); });
app.get('/api/drafts/:id/eml', wrap(async (req, res) => {
  const d = get('drafts', req.params.id);
  const eml = buildEml({ to: d.to_json, cc: d.cc_json, subject: d.subject, body: d.body, attachments: await draftAttachments(d) });
  update('drafts', d.id, { status: d.status === 'draft' ? 'draft' : d.status });
  res.type('message/rfc822').setHeader('Content-Disposition', `attachment; filename="${(d.subject || 'draft').replace(/[^\w .-]+/g, '').slice(0, 60)}.eml"`).send(eml);
}));
app.post('/api/drafts/:id/sent', (req, res) => {
  const d = update('drafts', req.params.id, { status: 'sent_by_user' });
  if (d.related_type === 'rfis') {
    const r = get('rfis', d.related_id);
    if (r && r.status === 'draft') update('rfis', r.id, { status: 'sent', date_sent: today(), date_required: r.date_required || addDays(today(), 7) });
  }
  if (d.related_type === 'submittals') {
    const s = get('submittals', d.related_id);
    if (s && !['submitted', 'approved', 'approved_as_noted'].includes(s.status)) update('submittals', s.id, { status: 'submitted', date_submitted: today() });
  }
  if (d.thread_id) update('threads', d.thread_id, { ball: 'them', suggested_reply: null });
  logActivity({ actor: 'user', kind: 'sent', project_id: d.project_id, title: `Sent: ${d.subject}`, detail: `To ${(d.to_json || []).map((a) => a.email).join(', ')}`, entity_type: 'drafts', entity_id: d.id });
  res.json(d);
});

// ---------- chat (streamed progress) ----------
app.get('/api/chats', (req, res) => res.json(listChats()));
app.get('/api/chats/:id', (req, res) => res.json(getChat(req.params.id) || { display: [] }));
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    const out = await chat({ chatId: req.body.chatId, projectId: req.body.projectId, message: String(req.body.message || '').slice(0, 8000), onStep: (s) => send('step', s) });
    send('done', out);
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
});

// ---------- tool bridge for the MCP server ----------
app.get('/api/agent/tools', (req, res) => res.json(TOOLS));
app.post('/api/agent/tool', wrap(async (req, res) => {
  try {
    res.json({ ok: true, result: await executeTool(req.body.name, req.body.input || {}, { actor: 'agent' }) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// ---------- schedule import (CSV from Excel / MS Project) ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const toIso = (v) => {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};
app.post('/api/projects/:id/schedule/import', (req, res) => {
  const rows = parseCsv(String(req.body.csv || ''));
  if (rows.length < 2) return res.status(400).json({ error: 'The file needs a header row and at least one activity.' });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const c = { name: col('task name', 'activity', 'name', 'task', 'description'), start: col('start'), finish: col('finish', 'end'), trade: col('trade'), who: col('resource', 'responsible', 'sub'), pct: col('% complete', 'percent', 'complete') };
  if (c.name < 0 || c.start < 0) return res.status(400).json({ error: 'Could not find "Name" and "Start" columns.' });
  if (req.body.replace) db.prepare("DELETE FROM schedule_items WHERE project_id = ? AND source = 'import'").run(req.params.id);
  let n = 0;
  for (const r of rows.slice(1)) {
    const name = r[c.name]?.trim();
    const start = toIso(r[c.start]);
    if (!name || !start) continue;
    const pct = c.pct >= 0 ? parseInt(r[c.pct], 10) || 0 : 0;
    insert('schedule_items', { project_id: req.params.id, name, start, finish: c.finish >= 0 ? toIso(r[c.finish]) : null, trade: c.trade >= 0 ? r[c.trade] : null, responsible: c.who >= 0 ? r[c.who] : null, percent: pct, status: pct >= 100 ? 'complete' : pct > 0 ? 'in_progress' : 'not_started', source: 'import', created_by: 'user' });
    n++;
  }
  logActivity({ actor: 'user', kind: 'import', project_id: req.params.id, title: `Imported ${n} schedule activities` });
  res.json({ imported: n });
});

// ---------- sample data, export ----------
app.post('/api/demo/load', wrap(async (req, res) => res.json(await loadDemo())));
app.post('/api/demo/clear', (req, res) => res.json(clearDemo()));
app.get('/api/export', (req, res) => {
  const dump = { exported_at: now(), version: VERSION };
  for (const t of [...Object.keys(ENTITIES), 'emails', 'activity_log', 'calendar_events']) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="nelson-os-backup-${today()}.json"`);
  res.json(dump);
});

// ---------- settings, phone access, system ----------
app.get('/api/settings', wrap(async (req, res) => {
  res.json({
    profile: profile(),
    ai: { effort: getSetting('ai.effort', 'medium'), model: getSetting('ai.model') || CONFIG.ai?.model },
    sync: { intervalMinutes: getSetting('sync.intervalMinutes', CONFIG.sync?.intervalMinutes || 10), lastSync: getSetting('mail.lastSync') },
    microsoft: { ...ms.status(), clientIdSource: getSetting('microsoft.clientId') ? 'settings' : CONFIG.microsoft?.clientId ? 'config' : 'missing', redirectUri: ms.REDIRECT_URI },
    system: { dataDir: DATA_DIR, appDir: APP_ROOT, vault: vaultInfo(), shortcuts: shortcutStatus(), openOnSignIn: !fs.existsSync(path.join(DATA_DIR, 'no-open-on-startup')), mcp: mcpStatus(), platform: process.platform },
    phone: { enabled: !!getSetting('phone.enabled'), hasPasscode: !!getSetting('phone.passcode') },
  });
}));
app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.effort) setSetting('ai.effort', b.effort);
  if (b.model) setSetting('ai.model', b.model);
  if (b.intervalMinutes) { setSetting('sync.intervalMinutes', Math.max(5, Number(b.intervalMinutes))); scheduleSync(); }
  res.json({ ok: true });
});
app.post('/api/system/shortcuts', (req, res) => {
  const { startup, desktop, openOnSignIn } = req.body || {};
  if (startup === true || desktop === true) installShortcuts({ startup: !!startup, desktop: !!desktop, menu: !!desktop });
  if (startup === false) removeShortcuts({ startup: true, desktop: false, menu: false });
  if (desktop === false) removeShortcuts({ startup: false, desktop: true, menu: true });
  const flag = path.join(DATA_DIR, 'no-open-on-startup');
  if (openOnSignIn === false) fs.writeFileSync(flag, '1');
  if (openOnSignIn === true) fs.rmSync(flag, { force: true });
  res.json(shortcutStatus());
});

app.post('/api/system/quit', (req, res) => {
  if (!isLocal(req)) return res.status(403).end();
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 200);
});

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`);
}
const hashPass = (pass, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pass), salt, 32).toString('hex') });
app.get('/api/phone', wrap(async (req, res) => {
  const urls = lanUrls();
  res.json({ enabled: !!getSetting('phone.enabled'), hasPasscode: !!getSetting('phone.passcode'), urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220, color: { dark: '#1A1B1C', light: '#FFFFFF' } }) : null });
}));
app.post('/api/phone', wrap(async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change phone access from the computer running Nelson OS.' });
  const { enabled, passcode } = req.body || {};
  if (passcode) {
    if (String(passcode).length < 6) return res.status(400).json({ error: 'Use a passcode of at least 6 characters.' });
    setSetting('phone.passcode', hashPass(passcode));
  }
  if (enabled && !getSetting('phone.passcode')) return res.status(400).json({ error: 'Set a passcode first.' });
  if (typeof enabled === 'boolean') {
    setSetting('phone.enabled', enabled);
    await listen();
  }
  res.json({ enabled: !!getSetting('phone.enabled'), urls: lanUrls() });
}));
app.post('/api/login', (req, res) => {
  const stored = getSetting('phone.passcode');
  if (!stored) return res.status(400).json({ error: 'Phone access is not set up.' });
  const { hash } = hashPass(req.body?.passcode || '', stored.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored.hash))) return res.status(401).json({ error: 'Wrong passcode.' });
  const exp = String(Date.now() + 30 * 86400000);
  res.setHeader('Set-Cookie', `nos_session=${encodeURIComponent(`${exp}.${sign(exp)}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
  res.json({ ok: true });
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'NO_AI' ? 409 : 500);
  if (status >= 500) console.error('[error]', req.method, req.path, err.message);
  res.status(status).json({ error: err.message, code: err.code });
});

// ---------- server + scheduler ----------
let server = null;
let boundHost = null;
async function listen() {
  const host = getSetting('phone.enabled') ? '0.0.0.0' : '127.0.0.1';
  if (server && boundHost === host) return;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((resolve, reject) => {
    server = app.listen(PORT, host, resolve);
    server.once('error', reject);
  });
  boundHost = host;
  server.on('error', (err) => console.error('[server]', err.message));
}

let syncTimer = null;
let procoreTimer = null;
function scheduleProcore() {
  clearInterval(procoreTimer);
  procoreTimer = setInterval(async () => {
    const s = procore.status();
    if (!s.connected) return;
    try { await procore.accessToken(); } catch (err) { console.warn('[procore] token refresh failed:', err.message); return; }
    // Full sync every 15 minutes; the token is kept fresh every 5.
    if (s.company && !s.sync.running && (!s.lastSync || Date.now() - new Date(s.lastSync).getTime() > 15 * 60000)) procore.syncProcore().catch(() => {});
  }, 5 * 60000);
}

function scheduleSync() {
  clearInterval(syncTimer);
  const minutes = getSetting('sync.intervalMinutes', CONFIG.sync?.intervalMinutes || 10);
  syncTimer = setInterval(() => {
    if (ms.status().connected && !syncState.running) syncMail().catch(() => {});
  }, minutes * 60000);
}

try {
  await listen();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.log(`Nelson OS is already running at http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
}
console.log(`Nelson OS ${VERSION} running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
scheduleSync();
scheduleProcore();
setTimeout(() => { if (ms.status().connected && !syncState.running) syncMail().catch(() => {}); }, 20000);
// Any document still marked "indexing" was interrupted by a restart.
for (const d of db.prepare("SELECT id FROM documents WHERE status = 'indexing'").all()) indexDocument(d.id).catch(() => {});
