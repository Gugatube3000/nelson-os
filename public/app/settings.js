import { html, useState, useEffect, api, useApi, useApp, toast, toastErr, fmtDate, Busy, Loading } from './lib.js';
import { ActivityList } from './projects.js';

export function Activity() {
  const [who, setWho] = useState('');
  const { data } = useApi('/activity?limit=200');
  const rows = (data || []).filter((a) => !who || a.actor === who);
  return html`<div class="page">
    <div class="page-head"><div><h1>Activity</h1><p class="muted">Everything Nelson OS did, and why.</p></div>
      <div class="seg">${[['', 'Everything'], ['agent', 'Nelson OS'], ['user', 'You'], ['system', 'Sync']].map(([k, l]) => html`<button class=${who === k ? 'on' : ''} onClick=${() => setWho(k)}>${l}</button>`)}</div></div>
    ${data ? html`<${ActivityList} items=${rows} />` : html`<${Loading} />`}
  </div>`;
}

export function Rules() {
  const { data } = useApi('/requirements');
  if (!data) return html`<div class="page"><${Loading} /></div>`;
  const verified = data.items.filter((r) => r.status === 'verified');
  const assumed = data.items.filter((r) => r.status !== 'verified');
  const card = (r) => html`<div class=${`panel req ${r.status}`} style="padding:14px 16px">
    <div class="spread" style="align-items:flex-start"><div><h3>${r.topic}</h3><div class="small muted">${r.jurisdiction}</div></div>
      <span class=${`chip ${r.status === 'verified' ? 'ok' : 'medium'}`}>${r.status === 'verified' ? `Checked ${fmtDate(r.checked)}` : 'Not verified'}</span></div>
    <p style="margin-top:8px">${r.rule}</p>
    <p class="small" style="margin-top:8px"><b>What to do:</b> ${r.action}</p>
    ${r.caveat && html`<p class="small muted" style="margin-top:6px">${r.caveat}</p>`}
    ${r.sources.length ? html`<div class="tiny" style="margin-top:8px">${r.sources.map((s) => html`<div><a href=${s.url} target="_blank" rel="noopener">${s.label}</a></div>`)}</div>` : null}
  </div>`;
  return html`<div class="page">
    <div class="page-head"><div><h1>Local rules</h1><p class="muted">Massachusetts and Greater Boston requirements Nelson OS uses when it advises you. Confirm with the building department before relying on anything that isn't checked.</p></div></div>
    <h2 style="margin-bottom:10px">Checked against official sources</h2>
    <div class="cards">${verified.map(card)}</div>
    <h2 style="margin:26px 0 10px">Common practice, not yet verified</h2>
    <div class="cards">${assumed.map(card)}</div>
  </div>`;
}

function Phone() {
  const { data, reload } = useApi('/phone');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return html`<${Loading} />`;
  const save = async (enabled) => {
    setBusy(true);
    try { await api('/phone', { method: 'POST', body: { enabled, ...(pass ? { passcode: pass } : {}) } }); setPass(''); toast(enabled ? 'Phone access is on' : 'Phone access is off'); reload(); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    <p class="small muted">Open Nelson OS on your phone while it is on the same Wi-Fi as this computer. For the jobsite, install Tailscale (free) on this computer and your phone, then use this computer's Tailscale address with port 4780.</p>
    ${!data.enabled ? html`<div class="row wrap">
      <input class="input" type="password" style="max-width:240px" placeholder=${data.hasPasscode ? 'Passcode (leave blank to keep)' : 'Choose a passcode (6+ characters)'} value=${pass} onInput=${(e) => setPass(e.target.value)} autocomplete="new-password" />
      <${Busy} class="btn primary" on=${busy} onClick=${() => save(true)}>Turn on phone access</${Busy}></div>` : html`<div class="row wrap" style="align-items:flex-start;gap:20px">
      ${data.qr && html`<img class="qr" src=${data.qr} alt="QR code for the phone address" />`}
      <div class="stack" style="gap:6px"><b>Scan with your phone camera</b>${data.urls.map((u) => html`<code>${u}</code>`)}
        <span class="small muted">Then use "Add to Home Screen" for an app icon.</span>
        <${Busy} class="btn" on=${busy} onClick=${() => save(false)}>Turn off phone access</${Busy}></div></div>`}
  </div>`;
}

export function Settings() {
  const { state, refresh } = useApp();
  const { data: s, reload } = useApi('/settings');
  const [p, setP] = useState(null);
  useEffect(() => { if (s) setP({ ...s.profile }); }, [s?.profile?.name]);
  if (!s || !p) return html`<div class="page"><${Loading} /></div>`;
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const saveProfile = async () => { try { await api('/profile', { method: 'POST', body: p }); toast('Saved'); refresh(); } catch (e) { toastErr(e); } };
  const shortcut = async (body) => { try { await api('/system/shortcuts', { method: 'POST', body }); toast('Updated'); reload(); } catch (e) { toastErr(e); } };
  const setting = async (body) => { try { await api('/settings', { method: 'POST', body }); toast('Saved'); reload(); } catch (e) { toastErr(e); } };
  const sys = s.system;
  const toggle = (on, onChange, title, sub) => html`<label class="row" style="align-items:flex-start;gap:12px;padding:12px 14px;border-top:1px solid var(--rule-soft);cursor:pointer">
    <input type="checkbox" checked=${on} onChange=${(e) => onChange(e.target.checked)} style="margin-top:4px;width:18px;height:18px;accent-color:var(--maroon)" />
    <span><b>${title}</b><br /><span class="small muted">${sub}</span></span></label>`;

  return html`<div class="page" style="max-width:860px">
    <div class="page-head"><h1>Settings</h1></div>

    <h2 style="margin-bottom:10px">You</h2>
    <div class="panel" style="padding:16px"><div class="grid2">
      <label class="field">Name<input class="input" value=${p.name} onInput=${set('name')} /></label>
      <label class="field">Title<input class="input" value=${p.title} onInput=${set('title')} /></label>
      <label class="field">Email<input class="input" value=${p.email} onInput=${set('email')} /></label>
      <label class="field">Cell<input class="input" value=${p.phone} onInput=${set('phone')} /></label>
    </div>
    <label class="field" style="margin-top:12px">Email signature<textarea class="input" rows="4" value=${p.signature} onInput=${set('signature')}></textarea></label>
    <div style="margin-top:12px"><button class="btn primary" onClick=${saveProfile}>Save</button></div></div>

    <h2 style="margin:26px 0 10px">This computer</h2>
    <div class="items">
      ${toggle(sys.shortcuts.startup, (v) => shortcut({ startup: v, openOnSignIn: v }), 'Start Nelson OS when I sign in', 'Runs in the background so email keeps syncing.')}
      ${toggle(sys.openOnSignIn, (v) => shortcut({ openOnSignIn: v }), 'Open today’s briefing at sign-in', 'Shows the briefing window when the computer starts.')}
      ${toggle(sys.shortcuts.desktop, (v) => shortcut({ desktop: v }), 'Desktop shortcut', 'A Nelson OS icon on the desktop and in the Start menu or Applications.')}
    </div>

    <h2 style="margin:26px 0 10px">Phone at the jobsite</h2>
    <div class="panel" style="padding:16px">${state.local ? html`<${Phone} />` : html`<p class="small muted">Change phone access from the computer running Nelson OS.</p>`}</div>

    <h2 style="margin:26px 0 10px">AI</h2>
    <div class="panel" style="padding:16px" class="stack">
      <p>Engine: <b>${state.engine.label}</b> <a class="small" href="#/connections" style="margin-left:8px">Change</a></p>
      <label class="field" style="margin-top:12px;max-width:340px">Thoroughness
        <select class="input" value=${s.ai.effort} onChange=${(e) => setting({ effort: e.target.value })}>
          <option value="low">Fast</option><option value="medium">Balanced (recommended)</option><option value="high">Thorough</option>
        </select></label>
    </div>

    <h2 style="margin:26px 0 10px">Email sync</h2>
    <div class="panel" style="padding:16px">
      <p class="small">${s.microsoft.connected ? `Connected as ${s.microsoft.account?.email}. Last checked ${s.sync.lastSync ? new Date(s.sync.lastSync).toLocaleString() : 'never'}.` : 'Outlook is not connected.'}</p>
      <label class="field" style="margin-top:12px;max-width:340px">Check for new email every
        <select class="input" value=${s.sync.intervalMinutes} onChange=${(e) => setting({ intervalMinutes: Number(e.target.value) })}>
          ${[5, 10, 15, 30, 60].map((m) => html`<option value=${m}>${m} minutes</option>`)}
        </select></label>
      ${s.microsoft.connected && html`<div class="row wrap" style="margin-top:12px"><button class="btn" onClick=${() => api('/sync/mail', { method: 'POST', body: { days: 30 } }).then(() => toast('Re-reading the last 30 days')).catch(toastErr)}>Re-read the last 30 days</button>
        <button class="btn" onClick=${() => api('/triage/run', { method: 'POST' }).then(() => toast('Sorting email again')).catch(toastErr)}>Sort email again with AI</button></div>`}
    </div>

    <h2 style="margin:26px 0 10px">Data</h2>
    <div class="panel" style="padding:16px" >
      <p class="small muted">Everything is stored on this computer in <code>${sys.dataDir}</code>. Passwords and sign-ins are encrypted (${sys.vault.protection}).</p>
      <div class="row wrap" style="margin-top:12px">
        <a class="btn" href="/api/export" download>Download a backup</a>
        ${state.demo ? html`<button class="btn" onClick=${() => api('/demo/clear', { method: 'POST' }).then(() => { toast('Sample projects removed'); refresh(); }).catch(toastErr)}>Remove sample projects</button>`
          : html`<button class="btn" onClick=${() => api('/demo/load', { method: 'POST' }).then(() => { toast('Sample projects loaded'); refresh(); }).catch(toastErr)}>Load sample projects</button>`}
        <a class="btn ghost" href="#/setup">Run setup again</a>
      </div>
    </div>
    <p class="tiny muted" style="margin-top:20px">Nelson OS ${state.version}</p>
  </div>`;
}
