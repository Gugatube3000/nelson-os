import { html, useState, useEffect, api, useApi, useApp, useRoute, toast, toastErr, Busy } from './lib.js';
import { AppTile } from './connections.js';

const STEPS = ['About you', 'Your AI', 'Procore', 'Outlook', 'First look', 'Start with your computer'];
const store = {
  get: () => { try { return Number(localStorage.getItem('nos.setupStep')) || 0; } catch { return 0; } },
  set: (n) => { try { localStorage.setItem('nos.setupStep', String(n)); } catch { /* private mode */ } },
};

function StepYou({ next }) {
  const { state, refresh } = useApp();
  const p = state.profile;
  const [f, setF] = useState({ name: p.name === 'Jonathan' && !p.email ? 'Jonathan' : p.name, title: p.title, email: p.email || state.microsoft.account?.email || '', phone: p.phone || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api('/profile', { method: 'POST', body: f }); await refresh(); next(); } catch (e) { toastErr(e); }
  };
  return html`<h2>Welcome to Nelson OS</h2>
    <p class="lead">One place for every active project: what needs you today, who you're waiting on, drawings you can ask questions about, and RFIs and submittals ready to send. Setup takes about five minutes.</p>
    <div class="grid2" style="max-width:620px">
      <label class="field">Your name<input class="input" value=${f.name} onInput=${set('name')} /></label>
      <label class="field">Title<input class="input" value=${f.title} onInput=${set('title')} placeholder="Project Manager" /></label>
      <label class="field">Work email<input class="input" type="email" value=${f.email} onInput=${set('email')} /></label>
      <label class="field">Cell (for signatures)<input class="input" value=${f.phone} onInput=${set('phone')} /></label>
    </div>
    <p class="small muted" style="margin-top:12px">Drafts are signed: ${[f.name, f.title, 'Nelson Group', f.phone].filter(Boolean).join(', ')}</p>
    <div class="row" style="margin-top:26px"><button class="btn primary lg" onClick=${save} disabled=${!f.name}>Continue</button></div>`;
}

function StepAI({ next }) {
  const { data, reload } = useApi('/connections');
  const [showKey, setShowKey] = useState(false);
  const apps = data?.apps || [];
  const connected = data && data.engine.engine !== 'none';
  return html`<h2>Connect your AI</h2>
    <p class="lead">Nelson OS uses the AI subscription you already pay for to read email, drawings and specs and to write drafts. Click Connect and sign in; it installs what it needs.</p>
    ${connected && html`<div class="banner info" style="max-width:720px"><span class="dot on"></span><span><b>${data.engine.label}</b> is connected on this computer.</span></div>`}
    <div class="tiles" style="max-width:760px">${apps.filter((a) => a.id === 'claude' || a.id === 'codex' || (showKey && a.id === 'anthropic')).map((a) => html`<${AppTile} key=${a.id} app=${a} onChange=${reload} />`)}</div>
    ${!showKey && html`<button class="btn ghost sm" style="margin-top:10px" onClick=${() => setShowKey(true)}>Use a Claude API key instead</button>`}
    <div class="row" style="margin-top:26px"><button class="btn primary lg" onClick=${next}>${connected ? 'Continue' : 'Skip for now'}</button></div>`;
}

function StepProcore({ next }) {
  const { data, reload } = useApi('/connections');
  const app = data?.apps.find((a) => a.id === 'procore');
  useEffect(() => { const id = setInterval(reload, 4000); return () => clearInterval(id); }, []);
  return html`<h2>Connect Procore</h2>
    <p class="lead">Procore is where your RFIs, submittals, schedule and project records live. Nelson OS reads them every 15 minutes and connects them to your email and drawings. It never changes anything in Procore unless you approve it first.</p>
    <div class="tiles" style="max-width:760px">${app && html`<${AppTile} app=${app} onChange=${reload} />`}</div>
    <div class="row" style="margin-top:26px"><button class="btn primary lg" onClick=${next}>${app?.connected ? 'Continue' : 'Skip for now'}</button></div>`;
}

function StepOutlook({ next }) {
  const { data, reload } = useApi('/connections');
  const outlook = data?.apps.find((a) => a.id === 'outlook');
  return html`<h2>Connect Outlook</h2>
    <p class="lead">Nelson OS reads the last 30 days of your email and your calendar to find active projects, who's waiting on you, RFIs, submittals, orders and dates. Access is read-only: it can't send, move or delete mail.</p>
    <p class="small muted" style="margin:-12px 0 20px;max-width:620px">You sign in with your work email and its usual password. For @nelsongc.com addresses this opens GoDaddy's sign-in page, which is normal.</p>
    <div class="tiles" style="max-width:760px">${outlook && html`<${AppTile} app=${outlook} onChange=${reload} />`}</div>
    <div class="row" style="margin-top:26px"><button class="btn primary lg" onClick=${next}>${outlook?.connected ? 'Continue' : 'Skip for now'}</button></div>`;
}

function StepImport({ next }) {
  const { state, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const s = state.sync;
  useEffect(() => { const id = setInterval(refresh, 2500); return () => clearInterval(id); }, []);
  const pct = s.running ? (s.total ? 40 + Math.round((s.done / s.total) * 55) : Math.min(38, 5 + s.fetched / 15)) : s.phase === 'done' ? 100 : 0;
  const demo = async () => { setBusy(true); try { await api('/demo/load', { method: 'POST' }); await refresh(); toast('Sample projects loaded'); } catch (e) { toastErr(e); } finally { setBusy(false); } };
  const pc = state.procore;
  return html`<h2>${state.microsoft.connected || pc.connected ? 'Bringing in your projects' : 'Take a first look'}</h2>
    ${pc.connected && html`<div class="row small" style="margin-bottom:14px"><span class=${pc.sync.running ? 'spinner' : 'dot on'}></span><span>Procore: ${pc.sync.running ? pc.sync.phase : pc.lastSync ? `${pc.sync.counts?.projects ?? ''} projects, ${pc.sync.counts?.rfis ?? ''} RFIs, ${pc.sync.counts?.submittals ?? ''} submittals synced` : pc.company ? 'starting…' : 'choose your company on the Procore step'}</span></div>`}
    ${state.microsoft.connected ? html`
      <p class="lead">This runs in the background. You can continue while it works.</p>
      <div style="max-width:620px" class="stack">
        <div class="progress"><div style=${`width:${pct}%`}></div></div>
        <div class="row small"><span class=${s.running ? 'spinner' : 'dot on'}></span><span>${s.running ? s.phase : s.phase === 'done' ? 'Finished' : s.error || 'Starting…'}</span></div>
        <div class="small muted">${s.fetched} emails · ${s.conversations || 0} conversations${s.total ? ` · ${s.done} of ${s.total} understood` : ''}</div>
        ${s.error && html`<div class="banner">${s.error}</div>`}
        ${!s.running && s.phase !== 'done' && html`<button class="btn" onClick=${() => api('/sync/mail', { method: 'POST' }).then(refresh).catch(toastErr)}>Start reading</button>`}
      </div>` : html`
      <p class="lead">${pc.connected ? 'Outlook isn’t connected yet; Procore projects appear below as they sync. ' : 'Outlook isn’t connected yet. '}You can also explore Nelson OS with three sample projects (clearly marked, removable in Settings) and connect Outlook later.</p>`}
    ${state.projects.length > 0 && html`<div style="margin-top:22px;max-width:620px"><h3 style="margin-bottom:8px">Projects found</h3><div class="items">${state.projects.map((p) => html`<div class="item" style="cursor:default"><b>${p.name}</b><span class="muted small">${[p.address, p.city].filter(Boolean).join(', ')}</span>${p.review ? html`<span class="chip review" style="margin-left:auto">Found in email</span>` : null}${p.source === 'demo' ? html`<span class="chip" style="margin-left:auto">Sample</span>` : null}${p.source === 'procore' ? html`<span class="chip ok" style="margin-left:auto">Procore</span>` : null}</div>`)}</div></div>`}
    <div class="row" style="margin-top:26px">
      ${!state.microsoft.connected && !pc.connected && !state.demo && html`<${Busy} class="btn" on=${busy} onClick=${demo}>Load sample projects</${Busy}>`}
      <button class="btn primary lg" onClick=${next}>Continue</button>
    </div>`;
}

function StepComputer({ finish }) {
  const [opts, setOpts] = useState({ startup: true, desktop: true });
  const [busy, setBusy] = useState(false);
  const { data: conns } = useApi('/connections');
  const mcp = conns?.apps.find((a) => a.id === 'mcp');
  const go = async () => {
    setBusy(true);
    try {
      await api('/system/shortcuts', { method: 'POST', body: { startup: opts.startup, desktop: opts.desktop, openOnSignIn: opts.startup } });
      if (mcp && !mcp.connected) await api('/connections/mcp/connect', { method: 'POST' }).catch(() => {});
      await api('/setup/complete', { method: 'POST' });
      store.set(0);
      finish();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const check = (k, title, sub) => html`<label class="row" style="align-items:flex-start;gap:12px;padding:12px 14px;border-top:1px solid var(--rule-soft);cursor:pointer">
    <input type="checkbox" checked=${opts[k]} onChange=${(e) => setOpts({ ...opts, [k]: e.target.checked })} style="margin-top:4px;width:18px;height:18px;accent-color:var(--maroon)" />
    <span><b>${title}</b><br /><span class="muted small">${sub}</span></span></label>`;
  return html`<h2>Start with your computer</h2>
    <p class="lead">Nelson OS runs quietly on this computer and keeps checking email every 10 minutes.</p>
    <div class="items" style="max-width:620px">
      ${check('startup', 'Open Nelson OS when I sign in', 'Starts in the background with Windows or macOS and opens today’s briefing.')}
      ${check('desktop', 'Put a Nelson OS shortcut on my desktop', 'Also adds it to the Start menu or Applications.')}
    </div>
    <p class="small muted" style="margin-top:12px">Nelson OS will also be available inside the Claude and Codex apps so you can ask about projects from there.</p>
    <div class="row" style="margin-top:26px"><${Busy} class="btn primary lg" on=${busy} onClick=${go}>Finish setup</${Busy}></div>`;
}

export function Setup() {
  const { refresh } = useApp();
  const route = useRoute();
  const [step, setStep] = useState(() => Number(route.query.step) || store.get());
  useEffect(() => { store.set(step); }, [step]);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const finish = async () => { toast('You’re set up'); location.hash = '#/'; await refresh(); };
  const views = [html`<${StepYou} next=${next} />`, html`<${StepAI} next=${next} />`, html`<${StepProcore} next=${next} />`, html`<${StepOutlook} next=${next} />`, html`<${StepImport} next=${next} />`, html`<${StepComputer} finish=${finish} />`];
  return html`<div class="setup">
    <aside class="setup-side">
      <img class="logo" src="/assets/nelson-logo.png" alt="Nelson Group" />
      <div><h1>Nelson OS</h1><p style="margin-top:6px">Construction operations for every active project.</p></div>
      <ol class="setup-steps">${STEPS.map((s, i) => html`<li class=${i === step ? 'on' : i < step ? 'done' : ''}><a href="#/setup" style="text-decoration:none;color:inherit" onClick=${(e) => { e.preventDefault(); if (i < step) setStep(i); }}>${s}</a></li>`)}</ol>
      <p class="why small" style="margin-top:auto">Your data stays on this computer. Email access is read-only: nothing is sent unless you press Send in Outlook, and nothing changes in Procore unless you approve it.</p>
    </aside>
    <section class="setup-main">${views[step]}</section>
  </div>`;
}
