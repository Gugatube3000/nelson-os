// Procore. Nelson OS signs in with Procore OAuth, keeps the token fresh, syncs projects, RFIs,
// submittals and the schedule, and runs the vendored procore-mcp-server (stdio MCP) for
// discovery and API calls.
//
// Guardrail: a change in Procore can email the architect, subs or owner, so nothing is ever
// written to Procore without Jonathan pressing Approve. Writes become rows in `approvals`;
// only decideApproval() executes them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_ROOT, BASE_URL, CONFIG, DATA_DIR } from '../paths.js';
import { db, get, getSetting, insert, logActivity, now, setSetting, today, update } from '../db.js';
import { getSecret, setSecret } from '../secrets.js';
import { resolveProject } from '../domain/projects.js';
import { addDays } from '../domain/risks.js';

export const TOKEN_PATH = path.join(DATA_DIR, 'procore-tokens.json');
// Procore accepts plain http only for exactly "http://localhost", so sign-in listens on port 80 briefly.
const CALLBACK_PORT = 80;
const REDIRECT_URI = 'http://localhost';
const MCP_ENTRY = path.join(APP_ROOT, 'vendor', 'procore-mcp-server', 'dist', 'src', 'index.js');

export function procoreConfig() {
  const env = getSetting('procore.env') || CONFIG.procore?.env || 'production';
  const sandbox = env === 'sandbox';
  return {
    clientId: getSetting('procore.clientId') || CONFIG.procore?.clientId || '',
    clientSecret: getSecret('procore_client_secret') || '',
    env,
    login: sandbox ? 'https://login-sandbox.procore.com' : 'https://login.procore.com',
    api: sandbox ? 'https://sandbox.procore.com' : 'https://api.procore.com',
    web: sandbox ? 'https://sandbox.procore.com' : 'https://app.procore.com',
    companyId: getSetting('procore.companyId'),
  };
}

const readTokens = () => { try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; } };
function writeTokens(t) {
  const tmp = `${TOKEN_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_PATH);
}
const tokenData = (r) => ({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: ((r.created_at || Math.floor(Date.now() / 1000)) + (r.expires_in || 5400)) * 1000 });

export const syncState = { running: false, phase: 'idle', error: null, finishedAt: null, counts: {} };

export function status() {
  const c = procoreConfig();
  return {
    configured: !!(c.clientId && c.clientSecret),
    connected: !!readTokens() && !!getSetting('procore.account'),
    account: getSetting('procore.account'),
    company: getSetting('procore.company'),
    companies: getSetting('procore.companies', []) || [],
    env: c.env,
    redirectUri: REDIRECT_URI,
    lastSync: getSetting('procore.lastSync'),
    sync: syncState,
    pendingApprovals: db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get().n,
  };
}

export function saveApp({ clientId, clientSecret, env }) {
  if (!String(clientId || '').trim() || !String(clientSecret || '').trim()) throw Object.assign(new Error('Enter both the Client ID and the Client Secret from the Procore Developer Portal.'), { status: 400 });
  setSetting('procore.clientId', String(clientId).trim());
  setSecret('procore_client_secret', String(clientSecret).trim());
  setSetting('procore.env', env === 'sandbox' ? 'sandbox' : 'production');
  return status();
}

// ---------- token ----------
let refreshing = null;
async function tokenRequest(params) {
  const c = procoreConfig();
  const res = await fetch(`${c.login}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) throw new Error(`Procore sign-in failed (${res.status}): ${json.error_description || json.error || text.slice(0, 200)}`);
  return json;
}

/** A valid access token. Refreshed well before expiry so the MCP child never has to (Procore rotates refresh tokens). */
export async function accessToken({ force = false } = {}) {
  const t = readTokens();
  if (!t) throw Object.assign(new Error('Procore is not connected.'), { code: 'NOT_CONNECTED' });
  if (!force && t.expires_at - 15 * 60 * 1000 > Date.now()) return t.access_token;
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    .then((r) => { const d = tokenData(r); writeTokens(d); return d; })
    .finally(() => { refreshing = null; });
  return (await refreshing).access_token;
}

// ---------- sign-in ----------
let callback = null;
let pendingAuth = null;

async function stopCallback() {
  const servers = callback || [];
  callback = null;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
}

function page(title, body, redirect) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>${redirect ? `<meta http-equiv="refresh" content="1;url=${redirect}">` : ''}
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F2F3F1;color:#1A1B1C">
<div style="text-align:center"><h2>${title}</h2><p>${body}</p>${redirect ? `<p><a href="${redirect}">Back to Nelson OS</a></p>` : ''}</div></body>`;
}

async function finishAuth(code) {
  const tokens = tokenData(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }));
  writeTokens(tokens);
  const me = (await procoreGet('/rest/v1.0/me')).data;
  setSetting('procore.account', { name: me.name, login: me.login });
  const companies = (await procoreGet('/rest/v1.0/companies')).data || [];
  setSetting('procore.companies', companies.map((x) => ({ id: x.id, name: x.name })));
  const pick = companies.length === 1 ? companies[0] : companies.find((x) => x.my_company) || null;
  if (pick && !getSetting('procore.companyId')) chooseCompany(pick.id);
  logActivity({ actor: 'user', kind: 'connect', title: `Connected Procore as ${me.name}`, detail: pick ? `Company: ${pick.name}` : 'Choose the company on the Connections page.', why: 'Signed in on the Connections page.' });
}

/** Start the Procore sign-in. Returns the Procore authorize URL to open. */
export async function startAuth({ returnTo = '/#/connections' } = {}) {
  const c = procoreConfig();
  if (!c.clientId || !c.clientSecret) throw Object.assign(new Error('Set up the Procore app first (Client ID and Secret).'), { status: 400 });
  await stopCallback();
  const state = crypto.randomBytes(16).toString('hex');
  pendingAuth = { state, returnTo, at: Date.now() };
  const back = (q) => `${BASE_URL}${returnTo.includes('?') ? `${returnTo}&` : `${returnTo}?`}${q}`;
  const handler = async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const gotState = url.searchParams.get('state');
    if (!code && !error) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Waiting for Procore…', 'Finish signing in in the Procore window.')); return; }
    // Procore echoes state; if it ever doesn't, the listener only exists during this ten-minute sign-in.
    if (!pendingAuth || (gotState && gotState !== pendingAuth.state) || Date.now() - pendingAuth.at > 10 * 60 * 1000) {
      res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(page('Sign-in expired', 'Click Connect in Nelson OS again.')); return;
    }
    pendingAuth = null;
    try {
      if (error) throw new Error(url.searchParams.get('error_description') || error);
      await finishAuth(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Procore connected', 'Returning to Nelson OS…', back('connected=procore')));
      if (getSetting('procore.companyId')) syncProcore().catch(() => {});
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Procore sign-in failed', err.message.replace(/</g, '&lt;'), back(`error=${encodeURIComponent(err.message)}`)));
    } finally {
      setTimeout(stopCallback, 1500);
    }
  };
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const s = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(CALLBACK_PORT, host, resolve); });
      servers.push(s);
    } catch (err) {
      if (host === '127.0.0.1') {
        throw Object.assign(new Error(err.code === 'EACCES'
          ? 'This computer blocked Nelson OS from finishing the Procore sign-in (port 80 needs permission). See docs/PROCORE-APP.md.'
          : 'Another program on this computer is using port 80, which Procore sign-in needs. Close it (often a local web server) and click Connect again.'), { status: 409 });
      }
    }
  }
  callback = servers;
  setTimeout(stopCallback, 10 * 60 * 1000).unref();
  const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT_URI, state });
  return `${c.login}/oauth/authorize?${q}`;
}

export function chooseCompany(companyId) {
  const companies = getSetting('procore.companies', []) || [];
  const company = companies.find((x) => String(x.id) === String(companyId));
  if (!company) throw Object.assign(new Error('That company is not on this Procore account.'), { status: 400 });
  setSetting('procore.companyId', company.id);
  setSetting('procore.company', company);
  closeMcp();
  return company;
}

export function disconnect() {
  fs.rmSync(TOKEN_PATH, { force: true });
  for (const k of ['procore.account', 'procore.companyId', 'procore.company', 'procore.companies']) setSetting(k, null);
  closeMcp();
}

// ---------- REST (reads only) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function procoreGet(pathname, query = {}) {
  const c = procoreConfig();
  const url = new URL(c.api + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = { Authorization: `Bearer ${await accessToken({ force: attempt > 0 && attempt === 1 })}` };
    if (c.companyId) headers['Procore-Company-Id'] = String(c.companyId);
    const res = await fetch(url, { headers });
    if (res.status === 429) { await sleep(Math.min(60, Number(res.headers.get('retry-after') || 5)) * 1000); continue; }
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw Object.assign(new Error(`Procore ${res.status} on ${pathname}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
    return { data: await res.json(), total: Number(res.headers.get('total')) || null };
  }
  throw new Error('Procore is rate limiting requests. Try again in a few minutes.');
}

async function getAll(pathname, query = {}, max = 1000) {
  const out = [];
  for (let pageNo = 1; out.length < max; pageNo++) {
    const { data } = await procoreGet(pathname, { ...query, page: pageNo, per_page: 100 });
    const rows = Array.isArray(data) ? data : data?.data || [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

// ---------- mapping Procore records to Nelson OS logs ----------
const text = (html) => (html ? String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim() : null);
const day = (d) => (d ? String(d).slice(0, 10) : null);
const impact = (x) => { const s = String(x?.status || x || '').toLowerCase(); return !s ? 'tbd' : /no_impact|n_a|none/.test(s) ? 'none' : /yes/.test(s) ? 'yes' : 'tbd'; };

export function mapRfi(r, web, pid) {
  const q = (r.questions || [])[0] || {};
  const answers = q.answers || [];
  const ans = answers.find((a) => a.official) || answers[answers.length - 1];
  const status = String(r.status) === 'closed' ? 'closed' : String(r.status) === 'draft' ? 'draft' : ans ? 'answered' : 'sent';
  const people = (r.assignees || []).map((a) => a.name).filter(Boolean);
  return {
    number: parseInt(String(r.number ?? '').replace(/[^\d]/g, ''), 10) || null,
    subject: r.subject || '(no subject)',
    question: text(q.plain_text_body || q.body),
    answer: text(ans?.plain_text_body || ans?.body),
    to_name: people.join(', ') || (r.ball_in_court || []).map((b) => b.name).filter(Boolean).join(', ') || null,
    to_email: r.assignees?.[0]?.login || null,
    status,
    date_sent: day(r.initiated_at || r.created_at),
    date_required: day(r.due_date),
    date_answered: day(ans?.created_at),
    cost_impact: impact(r.cost_impact),
    schedule_impact: impact(r.schedule_impact),
    drawing_refs: r.drawing_number || null,
    spec_refs: r.specification_section?.label || null,
    ext_url: `${web}/${pid}/project/rfi/show/${r.id}`,
  };
}

export function mapSubmittal(s, web, pid) {
  const st = String(s.status?.name || s.status?.status || s.status || '').toLowerCase();
  const status = /as noted/.test(st) ? 'approved_as_noted' : /approved/.test(st) ? 'approved' : /revise|resubmit/.test(st) ? 'revise_resubmit'
    : /reject/.test(st) ? 'rejected' : /closed/.test(st) ? 'closed' : /draft/.test(st) ? 'not_started' : /pending/.test(st) ? 'gc_review' : 'submitted';
  const reviewer = (s.approvers || []).map((a) => a.user?.name || a.name).find(Boolean) || s.submittal_manager?.name || null;
  const bic = (s.ball_in_court || []).map((b) => (typeof b.name === 'string' ? b.name : b.name?.name)).filter(Boolean);
  return {
    number: s.formatted_number || (s.number != null ? String(s.number) : null),
    title: s.title || '(untitled)',
    spec_section: s.specification_section?.number || s.specification_section?.label || null,
    kind: s.type?.name || null,
    supplier: s.responsible_contractor?.name || s.received_from?.name || null,
    reviewer_name: reviewer,
    status,
    required_onsite: day(s.required_on_site_date),
    lead_time_days: s.lead_time ?? null,
    date_submitted: day(s.issue_date || s.distributed_at),
    date_returned: day(s.closed_at),
    notes: bic.length ? `Ball in court in Procore: ${bic.join(', ')}` : null,
    ext_url: `${web}/${pid}/project/submittal_logs/${s.id}`,
  };
}

export function mapTask(t, web, pid) {
  const pct = Number(t.percentage || 0);
  return {
    name: t.task_name || t.name || '(task)',
    start: day(t.start_datetime),
    finish: day(t.finish_datetime),
    percent: pct,
    status: pct >= 100 ? 'complete' : pct > 0 ? 'in_progress' : 'not_started',
    responsible: t.resource_name || null,
    notes: t.critical_path ? 'Critical path (from Procore schedule)' : null,
    ext_url: `${web}/${pid}/project/schedule`,
  };
}

function upsert(table, projectId, procoreId, fields) {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE procore_id = ?`).get(String(procoreId));
  if (existing) return update(table, existing.id, fields);
  return insert(table, { ...fields, project_id: projectId, procore_id: String(procoreId), source: 'procore', review: 0, created_by: 'procore' });
}

/** Pull active projects and their RFIs, submittals and schedule from Procore. */
export async function syncProcore() {
  if (syncState.running) return syncState;
  const c = procoreConfig();
  if (!status().connected) throw Object.assign(new Error('Procore is not connected.'), { status: 400 });
  if (!c.companyId) throw Object.assign(new Error('Choose your Procore company first.'), { status: 400 });
  Object.assign(syncState, { running: true, phase: 'Reading Procore projects', error: null, counts: { projects: 0, rfis: 0, submittals: 0, tasks: 0, skipped: [] } });
  try {
    const projects = await getAll('/rest/v1.0/projects', { company_id: c.companyId, 'filters[by_status]': 'Active' }, 500);
    for (const p of projects) {
      const linked = db.prepare('SELECT * FROM projects WHERE procore_id = ?').get(String(p.id)) || resolveProject(p.display_name || p.name) || (p.address && resolveProject(p.address));
      const fields = { procore_id: String(p.id), ext_url: `${c.web}/${p.id}/project/home` };
      let local;
      if (linked) {
        // Keep names the team already uses; fill in what's missing.
        for (const [k, v] of Object.entries({ address: p.address, city: p.city, code: p.project_number, start_date: day(p.start_date), target_completion: day(p.completion_date) })) if (!linked[k] && v) fields[k] = v;
        local = update('projects', linked.id, fields);
      } else {
        local = insert('projects', { ...fields, name: p.display_name || p.name, address: p.address, city: p.city, code: p.project_number, start_date: day(p.start_date), target_completion: day(p.completion_date), status: 'active', source: 'procore', review: 0, created_by: 'procore' });
      }
      syncState.counts.projects++;
      syncState.phase = `Reading ${local.name}`;
      const steps = [
        ['rfis', () => getAll(`/rest/v1.0/projects/${p.id}/rfis`, {}, 1000), (r) => upsert('rfis', local.id, r.id, mapRfi(r, c.web, p.id))],
        ['submittals', () => getAll(`/rest/v1.1/projects/${p.id}/submittals`, {}, 1000), (s) => upsert('submittals', local.id, s.id, mapSubmittal(s, c.web, p.id))],
        ['tasks', () => getAll('/rest/v1.0/tasks', { project_id: p.id }, 3000), (t) => {
          const m = mapTask(t, c.web, p.id);
          if (t.has_children || !m.start || (m.finish || m.start) < addDays(today(), -14) || m.start > addDays(today(), 90)) return null;
          return upsert('schedule_items', local.id, t.id, m);
        }],
      ];
      for (const [kind, fetchAll, save] of steps) {
        try {
          for (const row of await fetchAll()) if (save(row)) syncState.counts[kind]++;
        } catch (err) {
          // 403/404 usually means the tool isn't enabled on that project or the user lacks access.
          syncState.counts.skipped.push(`${local.name}: ${kind} (${err.status || 'error'})`);
        }
      }
    }
    setSetting('procore.lastSync', now());
    const k = syncState.counts;
    logActivity({ actor: 'system', kind: 'sync', title: `Synced Procore: ${k.projects} projects, ${k.rfis} RFIs, ${k.submittals} submittals, ${k.tasks} schedule activities`, detail: k.skipped.length ? `Not available: ${k.skipped.slice(0, 6).join('; ')}` : '', why: 'Procore is the system of record for RFIs, submittals and the schedule.' });
  } catch (err) {
    syncState.error = err.message;
  } finally {
    syncState.running = false;
    syncState.phase = syncState.error ? 'error' : 'done';
    syncState.finishedAt = now();
  }
  return syncState;
}

// ---------- MCP (vendored procore-mcp-server) ----------
let mcp = null;
function closeMcp() {
  const c = mcp;
  mcp = null;
  c?.then((client) => client.close()).catch(() => {});
}

async function procoreMcp() {
  if (!mcp) {
    mcp = (async () => {
      const c = procoreConfig();
      await accessToken(); // make sure the token file is fresh before the child reads it
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_ENTRY],
        env: { ...getDefaultEnvironment(), PROCORE_CLIENT_ID: c.clientId, PROCORE_CLIENT_SECRET: c.clientSecret, PROCORE_COMPANY_ID: String(c.companyId || ''), PROCORE_ENV: c.env, PROCORE_TOKEN_PATH: TOKEN_PATH },
        stderr: 'ignore',
      });
      const client = new Client({ name: 'nelson-os', version: '1.0.0' });
      transport.onclose = () => { mcp = null; };
      await client.connect(transport);
      return client;
    })().catch((err) => { mcp = null; throw err; });
  }
  return mcp;
}

async function callMcp(name, args) {
  const client = await procoreMcp();
  const r = await client.callTool({ name, arguments: args });
  return (r.content || []).map((x) => x.text).join('\n');
}

export const findEndpoints = (query) => callMcp('procore_search_endpoints', { query });
export const endpointDetails = (operationId) => callMcp('procore_get_endpoint_details', { operation_id: operationId });

/** Read anything from Procore through the MCP server. GET only. */
export async function readProcore({ path: p, path_params, query_params, page, per_page }) {
  if (!status().connected) throw new Error('Procore is not connected. Connect it on the Connections page.');
  return callMcp('procore_api_call', { method: 'GET', path: p, path_params, query_params, page, per_page, company_id: procoreConfig().companyId || undefined });
}

// ---------- approvals: the only way anything is written to Procore ----------
export function requestChange({ method, path: p, path_params, body, title, notifies, reason, projectId, actor = 'agent' }) {
  const m = String(method || '').toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) throw new Error('Only changes need approval; use the read tool for GET requests.');
  if (!p || !title) throw new Error('A change needs a path and a plain-English title.');
  const a = insert('approvals', {
    system: 'procore', project_id: projectId || null, title, detail: body ? JSON.stringify(body, null, 1).slice(0, 4000) : null,
    method: m, path: p, path_params_json: path_params || {}, body_json: body || {}, notifies: notifies || null, reason,
    status: 'pending', source: actor, created_by: actor,
  });
  logActivity({ actor, kind: 'approval', project_id: projectId || null, title: `Asked for approval: ${title}`, detail: `${m} ${p}${notifies ? ` · Procore may notify: ${notifies}` : ''}`, why: reason, entity_type: 'approvals', entity_id: a.id });
  return { approval_id: a.id, status: 'Waiting for Jonathan to approve in Nelson OS. Nothing has changed in Procore.' };
}

export async function decideApproval(id, approve, { by = 'user' } = {}) {
  const a = get('approvals', id);
  if (!a) throw Object.assign(new Error('Approval not found'), { status: 404 });
  if (a.status !== 'pending') throw Object.assign(new Error(`Already ${a.status}.`), { status: 409 });
  if (by !== 'user') throw Object.assign(new Error('Only Jonathan can approve changes.'), { status: 403 });
  if (!approve) {
    update('approvals', id, { status: 'rejected', decided_at: now() });
    logActivity({ actor: 'user', kind: 'rejected', project_id: a.project_id, title: `Declined: ${a.title}`, entity_type: 'approvals', entity_id: id });
    return get('approvals', id);
  }
  let result;
  try {
    result = await callMcp('procore_api_call', { method: a.method, path: a.path, path_params: a.path_params_json, body: a.body_json, company_id: procoreConfig().companyId || undefined });
  } catch (err) {
    result = `Error: ${err.message}`;
  }
  const ok = /^Status: 2\d\d/.test(result);
  update('approvals', id, { status: ok ? 'done' : 'failed', result: result.slice(0, 4000), decided_at: now() });
  logActivity({ actor: 'user', kind: ok ? 'approved' : 'failed', project_id: a.project_id, title: `${ok ? 'Approved and sent to Procore' : 'Procore rejected'}: ${a.title}`, detail: result.split('\n')[0], entity_type: 'approvals', entity_id: id });
  if (ok) syncProcore().catch(() => {});
  return get('approvals', id);
}
