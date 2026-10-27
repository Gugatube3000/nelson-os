// Microsoft 365 / Outlook via Microsoft Graph. OAuth 2.0 authorization code + PKCE
// (public client, no secret). Read-only scopes: mail, calendar, and optionally files.
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { BASE_URL, CONFIG } from '../paths.js';
import { getSecret, setSecret } from '../secrets.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const REDIRECT_URI = `${BASE_URL}/oauth/microsoft/callback`;
const MAIL_SCOPES = ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.Read', 'Calendars.Read'];
const FILE_SCOPES = ['Files.Read.All'];

// ---------- no-send guardrail ----------
// Nelson OS reads Outlook; it never sends, replies, forwards, moves, edits or deletes mail.
// Every Graph call passes through assertReadOnly, so this holds even if a token were ever
// granted more permission than Nelson OS asks for. Email leaves only when Jonathan presses
// Send in Outlook.
const FORBIDDEN_SCOPE = /send|readwrite|\.write|full_access/i;
const SEND_PATH = /\/(sendmail|send|reply|replyall|forward|createreply|createreplyall|createforward|move|copy)(\/|$)/i;
const READ_ONLY_POSTS = [/^\/search\/query$/];

export function assertReadOnly(method, url) {
  const path = String(url).replace(/^https:\/\/graph\.microsoft\.com\/(v1\.0|beta)/i, '').split('?')[0];
  if (SEND_PATH.test(path)) throw Object.assign(new Error('Blocked: Nelson OS never sends, replies to, forwards or moves email. Open the draft in Outlook and send it yourself.'), { status: 403, code: 'SEND_BLOCKED' });
  if (method === 'GET') return;
  if (method === 'POST' && READ_ONLY_POSTS.some((re) => re.test(path))) return;
  throw Object.assign(new Error(`Blocked: Nelson OS only reads from Outlook (${method} ${path}).`), { status: 403, code: 'SEND_BLOCKED' });
}

export function assertReadOnlyScopes(scopes) {
  const bad = scopes.filter((s) => FORBIDDEN_SCOPE.test(s));
  if (bad.length) throw new Error(`Refusing to request write permissions: ${bad.join(', ')}`);
}

const pending = new Map();
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function msConfig() {
  return {
    clientId: getSetting('microsoft.clientId') || CONFIG.microsoft?.clientId || '',
    tenant: getSetting('microsoft.tenant') || CONFIG.microsoft?.tenant || 'common',
  };
}

const authority = () => `https://login.microsoftonline.com/${msConfig().tenant}/oauth2/v2.0`;

export function status() {
  const account = getSetting('microsoft.account');
  const scopes = getSetting('microsoft.scopes', []) || [];
  return {
    configured: !!msConfig().clientId,
    connected: !!account && !!getSecret('microsoft_tokens'),
    account,
    files: scopes.some((s) => /files\.read/i.test(s)),
    lastSync: getSetting('mail.lastSync'),
  };
}

export function authUrl({ files = false, returnTo = '/' } = {}) {
  const { clientId } = msConfig();
  if (!clientId) throw Object.assign(new Error('The Microsoft app is not set up yet. See docs/MICROSOFT-APP.md.'), { status: 400 });
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const granted = getSetting('microsoft.scopes', []) || [];
  const wantFiles = files || granted.some((s) => /files\.read/i.test(s));
  const scopes = [...MAIL_SCOPES, ...(wantFiles ? FILE_SCOPES : [])];
  assertReadOnlyScopes(scopes);
  pending.set(state, { verifier, scopes, returnTo, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60 * 1000) pending.delete(k);
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: scopes.join(' '),
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${authority()}/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: msConfig().clientId, ...params }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description?.split('\r\n')[0] || json.error || `Token request failed (${res.status})`);
  return json;
}

function saveTokens(t, previous = {}) {
  setSecret('microsoft_tokens', {
    access_token: t.access_token,
    refresh_token: t.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (t.expires_in || 3600) * 1000,
  });
  if (t.scope) setSetting('microsoft.scopes', t.scope.split(' ').map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//, '')));
}

// Some companies (common with Microsoft 365 bought through GoDaddy) only let an admin approve
// outside apps. The admin opens this link once and clicks Accept for the whole company.
export function adminConsentUrl(tenant = 'organizations') {
  const q = new URLSearchParams({ client_id: msConfig().clientId, scope: 'https://graph.microsoft.com/.default', redirect_uri: REDIRECT_URI, state: 'admin-consent' });
  return `https://login.microsoftonline.com/${tenant}/v2.0/adminconsent?${q}`;
}
const NEEDS_ADMIN = /AADSTS(90094|90095|65001)|admin (approval|consent)|needs permission to access resources/i;

export async function finishAuth({ code, state, error, error_description: desc, admin_consent: adminConsent }) {
  if (adminConsent) {
    if (String(adminConsent).toLowerCase() !== 'true') throw new Error(String(desc || 'The admin approval was not completed.').split('\r\n')[0]);
    return { returnTo: '/#/connections', adminConsented: true };
  }
  if (error) {
    if (NEEDS_ADMIN.test(`${error} ${desc || ''}`)) {
      throw new Error(`Nelson Group's Microsoft 365 needs an admin to approve Nelson OS once. Ask whoever manages the Microsoft 365 account (the GoDaddy Microsoft 365 admin) to open this link, sign in and click Accept: ${adminConsentUrl()}`);
    }
    throw new Error(String(desc || error).split('\r\n')[0]);
  }
  const p = pending.get(state);
  if (!p) throw new Error('This sign-in link expired. Click Connect again.');
  pending.delete(state);
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: p.verifier, scope: p.scopes.join(' ') });
  saveTokens(t);
  const me = await graph('/me?$select=displayName,mail,userPrincipalName');
  setSetting('microsoft.account', { name: me.displayName, email: (me.mail || me.userPrincipalName || '').toLowerCase() });
  return { returnTo: p.returnTo };
}

async function accessToken() {
  const t = getSecret('microsoft_tokens');
  if (!t) throw Object.assign(new Error('Outlook is not connected.'), { code: 'NOT_CONNECTED' });
  if (t.expires_at - 120000 > Date.now()) return t.access_token;
  const scopes = getSetting('microsoft.scopes', []) || [];
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: [...new Set([...MAIL_SCOPES, ...scopes.filter((s) => /\./.test(s))])].join(' ') });
  saveTokens(fresh, t);
  return fresh.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET (or POST) against Microsoft Graph with retry on throttling. */
export async function graph(pathOrUrl, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  assertReadOnly(method.toUpperCase(), url);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      await sleep(Number(res.headers.get('retry-after') || 2 ** attempt) * 1000);
      continue;
    }
    if (res.status === 401 && attempt === 0) {
      const t = getSecret('microsoft_tokens');
      if (t) setSecret('microsoft_tokens', { ...t, expires_at: 0 });
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch { /* keep text */ }
      throw Object.assign(new Error(`Microsoft Graph: ${msg.slice(0, 300)}`), { status: res.status });
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
  throw new Error('Microsoft Graph is throttling requests. Try again in a few minutes.');
}

export async function* pages(path, opts) {
  let next = path;
  while (next) {
    const page = await graph(next, opts);
    yield page.value || [];
    next = page['@odata.nextLink'];
  }
}

export function disconnect() {
  setSecret('microsoft_tokens', null);
  setSetting('microsoft.account', null);
  setSetting('microsoft.scopes', []);
}

// ---------- files (OneDrive / SharePoint) ----------
export async function searchFiles(query) {
  try {
    const res = await graph('/search/query', {
      method: 'POST',
      body: { requests: [{ entityTypes: ['driveItem'], query: { queryString: `${query} filetype:pdf` }, from: 0, size: 25 }] },
    });
    const hits = res.value?.[0]?.hitsContainers?.[0]?.hits || [];
    return hits.map((h) => h.resource).map((r) => ({ id: r.id, driveId: r.parentReference?.driveId, name: r.name, size: r.size, webUrl: r.webUrl, modified: r.lastModifiedDateTime, path: r.parentReference?.path?.replace(/^.*root:/, '') || '' }));
  } catch {
    // Personal Microsoft accounts don't support /search/query; search the user's own OneDrive.
    const res = await graph(`/me/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')?$top=50&$select=id,name,size,webUrl,file,parentReference,lastModifiedDateTime`);
    return (res.value || []).filter((r) => /\.pdf$/i.test(r.name)).map((r) => ({ id: r.id, driveId: r.parentReference?.driveId, name: r.name, size: r.size, webUrl: r.webUrl, modified: r.lastModifiedDateTime, path: r.parentReference?.path?.replace(/^.*root:/, '') || '' }));
  }
}

export async function downloadFile(driveId, itemId) {
  return graph(driveId ? `/drives/${driveId}/items/${itemId}/content` : `/me/drive/items/${itemId}/content`, { raw: true });
}

export async function listAttachments(messageId) {
  const res = await graph(`/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`);
  return (res.value || []).filter((a) => !a.isInline);
}

export async function downloadAttachment(messageId, attachmentId) {
  const a = await graph(`/me/messages/${messageId}/attachments/${attachmentId}`);
  if (!a.contentBytes) throw new Error('That attachment is not a file.');
  return { name: a.name, contentType: a.contentType, bytes: Buffer.from(a.contentBytes, 'base64') };
}
