import { html, useState, useEffect, api, useApi, useApp, toast, toastErr, Drawer, Busy, Loading, go } from './lib.js';

const GROUPS = [
  ['ai', 'Your AI', 'Pick one. Your Claude or ChatGPT subscription works; no API key needed.'],
  ['data', 'Your project data', 'Nelson OS never sends email, and nothing changes in Procore until you approve it.'],
  ['use', 'Use Nelson OS from', null],
  ['later', 'Planned', 'Not connected yet. Ask Gustavo if you need one of these sooner.'],
];

function CliConnect({ app, onDone }) {
  const [job, setJob] = useState(null);
  const [code, setCode] = useState('');
  useEffect(() => {
    if (!job || job.state !== 'running') return undefined;
    const id = setInterval(async () => {
      const j = await api(`/connections/jobs/connect:${app.id}`).catch(() => null);
      if (!j) return;
      setJob(j);
      if (j.state === 'done') { toast(`${app.name} connected`); onDone(); }
      if (j.state === 'error') toastErr(j.error);
    }, 2000);
    return () => clearInterval(id);
  }, [job?.state]);
  const start = async () => {
    try { setJob((await api(`/connections/${app.id}/connect`, { method: 'POST' })).job); } catch (e) { toastErr(e); }
  };
  const sendCode = async () => {
    try { await api(`/connections/${app.id}/code`, { method: 'POST', body: { code } }); setCode(''); toast('Code sent'); } catch (e) { toastErr(e); }
  };
  if (job?.state === 'running') {
    return html`<div class="job stack" style="gap:8px">
      <div class="row"><span class="spinner"></span><span>${job.step}</span></div>
      ${job.url && html`<a class="btn sm" href=${job.url} target="_blank" rel="noopener">Open the sign-in page</a>`}
      ${job.acceptsCode && html`<div class="row"><input class="input" placeholder="Paste the code shown after sign-in" value=${code} onInput=${(e) => setCode(e.target.value)} /><button class="btn sm dark" onClick=${sendCode} disabled=${!code}>Submit</button></div>`}
    </div>`;
  }
  return html`<button class="btn primary" onClick=${start}>${app.installed ? 'Connect' : 'Install and connect'}</button>`;
}

function KeyConnect({ onDone }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return html`<button class="btn" onClick=${() => setOpen(true)}>Add API key</button>`;
  const save = async () => {
    setBusy(true);
    try { await api('/connections/anthropic/connect', { method: 'POST', body: { apiKey: key } }); toast('Claude API key saved'); onDone(); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return html`<div class="stack" style="gap:8px">
    <input class="input" type="password" placeholder="sk-ant-..." value=${key} onInput=${(e) => setKey(e.target.value)} autocomplete="off" />
    <div class="row"><${Busy} class="btn primary sm" on=${busy} onClick=${save} disabled=${!key}>Save key</${Busy}>
    <a class="small" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get a key</a></div>
    <p class="tiny muted">Stored encrypted on this computer.</p>
  </div>`;
}

export function MicrosoftSetup({ onClose, onSaved }) {
  const { data } = useApi('/settings');
  const [clientId, setClientId] = useState('');
  const redirect = data?.microsoft?.redirectUri || `${location.origin}/oauth/microsoft/callback`;
  const save = async () => {
    try { await api('/connections/microsoft/app', { method: 'POST', body: { clientId } }); toast('Microsoft sign-in is set up'); onSaved?.(); onClose(); } catch (e) { toastErr(e); }
  };
  return html`<${Drawer} title="Set up Microsoft sign-in" sub="One time, about 5 minutes. Usually done by Gustavo or whoever manages the Microsoft 365 account." onClose=${onClose}
    foot=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save} disabled=${!clientId}>Save</button>`}>
    <ol class="stack" style="padding-left:18px;gap:10px">
      <li>Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra: App registrations</a> and choose <b>New registration</b>.</li>
      <li>Name it <b>Nelson OS</b>. Under supported account types choose <b>Accounts in any organizational directory and personal Microsoft accounts</b>.</li>
      <li>Under Redirect URI choose <b>Public client/native (mobile & desktop)</b> and enter:
        <div class="row" style="margin-top:6px"><input class="input" readonly value=${redirect} /><button class="btn sm" onClick=${() => navigator.clipboard.writeText(redirect).then(() => toast('Copied'))}>Copy</button></div></li>
      <li>Click <b>Register</b>, then copy the <b>Application (client) ID</b> and paste it here.</li>
    </ol>
    <label class="field" style="margin-top:16px">Application (client) ID<input class="input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value=${clientId} onInput=${(e) => setClientId(e.target.value.trim())} /></label>
    <p class="small muted" style="margin-top:12px">No secret is needed. Nelson OS asks only for read access to mail, calendar and files, plus your basic profile. To ship this to every computer, put the ID in <code>config/defaults.json</code> under microsoft.clientId.</p>
  </${Drawer}>`;
}

export function ProcoreSetup({ onClose, onSaved }) {
  const [f, setF] = useState({ clientId: '', clientSecret: '', env: 'production' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value.trim() });
  const save = async () => {
    try { await api('/connections/procore/app', { method: 'POST', body: f }); toast('Procore app saved'); onSaved?.(); onClose(); } catch (e) { toastErr(e); }
  };
  return html`<${Drawer} title="Set up the Procore app" sub="One time. Gustavo creates the app; a Nelson Group Procore admin installs it." onClose=${onClose}
    foot=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save} disabled=${!f.clientId || !f.clientSecret}>Save</button>`}>
    <h3 style="margin-bottom:8px">1. Create the app (Gustavo)</h3>
    <ol class="stack small" style="padding-left:18px;gap:6px">
      <li>Sign in at <a href="https://developers.procore.com" target="_blank" rel="noopener">developers.procore.com</a> → <b>My Apps</b> → <b>Create New App</b>, name it <b>Nelson OS</b>.</li>
      <li>Open <b>OAuth Credentials</b> (Production). Set the Redirect URI to exactly <code>http://localhost</code>. Copy the Client ID and Client Secret.</li>
      <li>Under <b>Manage Manifests → Production</b>, create a version with a <b>Data Connection</b> component using the <b>authorization_code</b> grant, then promote it. Copy the <b>App Version ID</b>.</li>
    </ol>
    <h3 style="margin:16px 0 8px">2. Install it in Nelson Group's Procore (company admin)</h3>
    <p class="small">Procore → <b>Company Admin → App Management → Install App → Install Custom App</b>, paste the App Version ID, and confirm.</p>
    <h3 style="margin:16px 0 8px">3. Paste the credentials here</h3>
    <div class="stack">
      <label class="field">Client ID<input class="input" value=${f.clientId} onInput=${set('clientId')} /></label>
      <label class="field">Client Secret<input class="input" type="password" value=${f.clientSecret} onInput=${set('clientSecret')} autocomplete="off" /></label>
      <label class="field">Environment<select class="input" value=${f.env} onChange=${set('env')}><option value="production">Production</option><option value="sandbox">Sandbox (testing)</option></select></label>
    </div>
    <p class="small muted" style="margin-top:12px">The secret is stored encrypted on this computer. Nelson OS reads Procore freely; anything that would change Procore waits for your approval first.</p>
  </${Drawer}>`;
}

function ProcoreCompany({ app, onDone }) {
  const [id, setId] = useState(app.companies?.[0]?.id || '');
  const save = async () => { try { await api('/connections/procore/company', { method: 'POST', body: { companyId: id } }); toast('Reading Procore projects'); onDone(); } catch (e) { toastErr(e); } };
  return html`<div class="row"><select class="input" value=${id} onChange=${(e) => setId(e.target.value)} aria-label="Procore company">${(app.companies || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><button class="btn primary sm" onClick=${save} disabled=${!id}>Use</button></div>`;
}

export function AppTile({ app, onChange, compact }) {
  const { refresh } = useApp();
  const [msSetup, setMsSetup] = useState(false);
  const [pcSetup, setPcSetup] = useState(false);
  const done = () => { onChange?.(); refresh(); };
  const act = async (path, msg) => { try { await api(path, { method: 'POST' }); if (msg) toast(msg); done(); } catch (e) { toastErr(e); } };
  const connectOAuth = async () => {
    try {
      const { url } = await api(`/connections/${app.id}/connect`, { method: 'POST', body: { returnTo: `/${location.hash}` } });
      location.href = url;
    } catch (e) { toastErr(e); }
  };
  let action = null;
  if (app.kind === 'planned') action = html`<button class="btn" disabled>Planned</button>`;
  else if (app.kind === 'subscription') {
    action = app.connected
      ? (app.active ? html`<span class="chip ok">Active AI</span>` : html`<button class="btn" onClick=${() => act(`/connections/${app.id}/use`, `Using ${app.name}`)}>Use for AI</button>`)
      : html`<${CliConnect} app=${app} onDone=${done} />`;
  } else if (app.kind === 'key') {
    action = app.connected
      ? html`<div class="row">${app.active ? html`<span class="chip ok">Active AI</span>` : html`<button class="btn" onClick=${() => act('/connections/anthropic/use', 'Using the Claude API')}>Use for AI</button>`}<button class="btn ghost sm" onClick=${() => act('/connections/anthropic/disconnect', 'Key removed')}>Remove</button></div>`
      : html`<${KeyConnect} onDone=${done} />`;
  } else if (app.kind === 'procore') {
    if (!app.configured) action = html`<button class="btn primary" onClick=${() => setPcSetup(true)}>Set up Procore app</button>`;
    else if (app.needsCompany) action = html`<${ProcoreCompany} app=${app} onDone=${done} />`;
    else if (app.connected) action = html`<div class="row">${app.syncing ? html`<span class="small muted"><span class="spinner" style="width:12px;height:12px;vertical-align:-2px"></span> Syncing</span>` : html`<button class="btn" onClick=${() => act('/procore/sync', 'Syncing Procore')}>Sync now</button>`}<button class="btn ghost sm" onClick=${() => act('/connections/procore/disconnect', 'Disconnected')}>Disconnect</button></div>`;
    else action = html`<div class="row"><button class="btn primary" onClick=${connectOAuth}>Connect</button><button class="btn ghost sm" onClick=${() => setPcSetup(true)}>App settings</button></div>`;
  } else if (app.kind === 'oauth') {
    if (!app.configured) action = html`<button class="btn" onClick=${() => setMsSetup(true)}>Set up Microsoft sign-in</button>`;
    else if (app.connected) action = html`<div class="row">${app.id === 'outlook' && html`<button class="btn" onClick=${() => act('/sync/mail', 'Syncing Outlook')}>Sync now</button>`}<button class="btn ghost sm" onClick=${() => act(`/connections/${app.id}/disconnect`, 'Disconnected')}>Disconnect</button></div>`;
    else action = html`<button class="btn primary" onClick=${connectOAuth}>Connect</button>`;
  } else if (app.id === 'mcp') {
    action = html`<button class="btn" onClick=${() => act('/connections/mcp/connect', 'Nelson OS added to Claude and Codex')}>${app.connected ? 'Re-register' : 'Connect'}</button>`;
  } else if (app.id === 'phone') action = html`<button class="btn" onClick=${() => go('#/settings')}>${app.connected ? 'Manage' : 'Set up'}</button>`;
  else if (app.id === 'drawings') action = html`<button class="btn" onClick=${() => go('#/projects')}>Open projects</button>`;

  return html`<div class=${`tile${app.active ? ' active' : ''}${app.kind === 'planned' ? ' planned' : ''}`}>
    <div class="row"><div class="logo"><img src=${`/assets/apps/${app.logo}`} alt="" /></div><div class="grow"><div class="name">${app.name}</div>
      <div class="status"><span class=${`dot ${app.connected ? 'on' : (app.kind === 'oauth' || app.kind === 'procore') && !app.configured ? 'warn' : 'off'}`}></span>${app.connected ? app.detail || 'Connected' : app.detail || (app.kind === 'planned' ? 'Not available yet' : 'Not connected')}</div></div></div>
    ${!compact && html`<div class="blurb">${app.blurb}</div>`}
    <div>${action}</div>
    ${msSetup && html`<${MicrosoftSetup} onClose=${() => setMsSetup(false)} onSaved=${done} />`}
    ${pcSetup && html`<${ProcoreSetup} onClose=${() => setPcSetup(false)} onSaved=${done} />`}
  </div>`;
}

export function Connections({ query }) {
  const { data, reload, loading } = useApi('/connections');
  useEffect(() => { if (query?.error) toastErr(query.error); if (query?.connected) toast(query.connected === 'procore' ? 'Procore connected. Reading your projects now.' : 'Outlook connected. Reading the last 30 days now.'); }, []);
  if (!data) return html`<div class="page">${loading && html`<${Loading} />`}</div>`;
  return html`<div class="page">
    <div class="page-head"><div><h1>Connections</h1><p class="muted">AI engine: <b>${data.engine.label}</b></p></div></div>
    ${GROUPS.map(([g, title, note]) => html`
      <div class="section-title"><h2>${title}</h2></div>
      ${note && html`<p class="muted small" style="margin:-4px 0 12px">${note}</p>`}
      <div class="tiles">${data.apps.filter((a) => a.group === g).map((a) => html`<${AppTile} key=${a.id} app=${a} onChange=${reload} />`)}</div>`)}
  </div>`;
}
