import { html, render, useState, useEffect, useCallback, api, useRoute, AppCtx, Toaster, Icon, toastErr } from './lib.js';
import { Setup } from './setup.js';
import { Today } from './today.js';
import { Inbox } from './inbox.js';
import { Projects, ProjectPage } from './projects.js';
import { Ask } from './ask.js';
import { Drafts } from './drafts.js';
import { Connections } from './connections.js';
import { Settings, Activity, Rules } from './settings.js';
import { useErrorBoundary } from '/vendor/htm-preact.mjs';

// One screen failing must never take down the whole app.
function ScreenGuard({ children }) {
  const [error, reset] = useErrorBoundary((err) => console.error('[screen]', err));
  if (!error) return children;
  return html`<div class="page"><div class="panel empty"><b>This screen hit a problem</b>Your data is safe. Reload the screen, or open another page from the menu.
    <div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" onClick=${() => { reset(); location.reload(); }}>Reload</button></div>
    <p class="tiny muted" style="margin-top:10px">${String(error.message || error).slice(0, 200)}</p></div></div>`;
}

const NAV = [
  ['#/', 'Today', Icon.today, 'today'],
  ['#/inbox', 'Inbox', Icon.inbox, 'inbox'],
  ['#/projects', 'Projects', Icon.projects, 'projects'],
  ['#/ask', 'Ask', Icon.ask, 'ask'],
  ['#/drafts', 'Approvals', Icon.drafts, 'drafts'],
  ['#/activity', 'Activity', Icon.activity, 'activity'],
  ['#/rules', 'Local rules', Icon.rules, 'rules'],
  ['#/connections', 'Connections', Icon.plug, 'connections'],
  ['#/settings', 'Settings', Icon.settings, 'settings'],
];
const TABS = ['today', 'inbox', 'projects', 'ask'];

function Login({ onDone }) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { passcode: pass } }); location.hash = '#/'; onDone(); } catch (x) { setErr(x.message); }
  };
  return html`<div class="boot"><form class="panel stack" style="padding:28px;width:min(360px,92vw)" onSubmit=${submit}>
    <img src="/assets/nelson-logo.png" alt="Nelson Group" style="width:180px;background:#fff;padding:6px;border-radius:3px" />
    <h2>Nelson OS</h2>
    <label class="field">Passcode<input class="input" type="password" autocomplete="current-password" value=${pass} onInput=${(e) => setPass(e.target.value)} autofocus /></label>
    ${err && html`<div class="banner">${err}</div>`}
    <button class="btn primary lg">Open Nelson OS</button>
  </form></div>`;
}

function Shell({ state, children, section, counts }) {
  const sync = state.sync;
  const engine = state.engine;
  return html`<div class="shell">
    <nav class="rail" aria-label="Main">
      <a class="brand" href="#/"><img class="mark" src="/assets/mark.svg" alt="" /><div><b>Nelson OS</b><span>${state.company}</span></div></a>
      <div class="nav">
        ${NAV.map(([href, name, icon, key]) => html`<a href=${href} class=${section === key ? 'on' : ''}>${icon}<span>${name}</span>${key === 'today' && counts.high ? html`<span class="count">${counts.high}</span>` : key === 'drafts' && counts.drafts ? html`<span class="count">${counts.drafts}</span>` : null}</a>`)}
      </div>
      <div class="foot">
        <div class="row"><span class=${`dot ${engine.engine === 'none' ? 'warn' : 'on'}`}></span>AI: ${engine.label}</div>
        <div class="row" style="margin-top:4px"><span class=${`dot ${state.procore?.connected ? 'on' : 'off'}`}></span>${state.procore?.connected ? (state.procore.sync.running ? 'Syncing Procore' : 'Procore connected') : 'Procore not connected'}</div>
        <div class="row" style="margin-top:4px"><span class=${`dot ${state.microsoft.connected ? 'on' : 'off'}`}></span>${state.microsoft.connected ? (sync.running ? `Syncing: ${sync.phase}` : 'Outlook connected') : 'Outlook not connected'}</div>
      </div>
    </nav>
    <main class="main">
      <div class="mobile-brand"><img src="/assets/mark.svg" alt="" /><b style="font-stretch:115%">Nelson OS</b></div>
      ${children}
    </main>
    <nav class="tabbar" aria-label="Main">
      ${NAV.filter(([, , , k]) => TABS.includes(k)).map(([href, name, icon, key]) => html`<a href=${href} class=${section === key ? 'on' : ''}>${icon}<span>${name}</span>${key === 'today' && counts.high ? html`<span class="count">${counts.high}</span>` : null}</a>`)}
      <a href="#/more" class=${['drafts', 'activity', 'rules', 'connections', 'settings', 'more'].includes(section) ? 'on' : ''}>${Icon.more}<span>More</span></a>
    </nav>
  </div>`;
}

function More() {
  return html`<div class="page"><h1 style="margin-bottom:16px">More</h1><div class="items">
    ${NAV.filter(([, , , k]) => !TABS.includes(k)).map(([href, name, icon]) => html`<a class="item" href=${href} style="text-decoration:none"><span style="width:20px">${icon}</span><b>${name}</b></a>`)}
  </div></div>`;
}

function App() {
  const route = useRoute();
  const [state, setState] = useState(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [counts, setCounts] = useState({});
  const [connectionError, setConnectionError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api('/state');
      setConnectionError(null);
      setState(s);
      setNeedLogin(false);
      if (s.setupComplete) {
        const [b, d] = await Promise.all([api('/briefing'), api('/drafts')]);
        setCounts({ high: b.counts.high, drafts: d.length + (s.procore?.pendingApprovals || 0) });
      }
    } catch (e) {
      if (/passcode/i.test(e.message)) setNeedLogin(true); else setConnectionError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    // While the server restarts, check every few seconds so the screen comes back on its own.
    const busy = state?.sync?.running || state?.procore?.sync?.running;
    const id = setInterval(refresh, connectionError ? 3000 : busy ? 4000 : 60000);
    return () => clearInterval(id);
  }, [state?.sync?.running, state?.procore?.sync?.running, connectionError]);

  if (needLogin || route.path === '/login') return html`<${Login} onDone=${refresh} /><${Toaster} />`;
  if (!state) return html`<div class="boot"><div class="stack" style="max-width:440px;padding:24px"><img src="/assets/mark.svg" alt="" width="88" />${connectionError && html`<h2>Could not open Nelson OS</h2><p>${connectionError}</p><button class="btn primary" onClick=${refresh}>Try again</button>`}</div></div>`;
  if (!state.setupComplete || route.path === '/setup') return html`<${AppCtx.Provider} value=${{ state, refresh }}><${Setup} /><${Toaster} /></${AppCtx.Provider}>`;

  const [section = 'today', id, tab] = route.parts;
  let view;
  switch (section) {
    case 'inbox': view = html`<${Inbox} openId=${id} />`; break;
    case 'projects': view = id ? html`<${ProjectPage} id=${id} tab=${tab || 'overview'} />` : html`<${Projects} />`; break;
    case 'ask': view = html`<${Ask} chatId=${id} query=${route.query} />`; break;
    case 'drafts': view = html`<${Drafts} openId=${id} />`; break;
    case 'activity': view = html`<${Activity} />`; break;
    case 'rules': view = html`<${Rules} />`; break;
    case 'connections': view = html`<${Connections} query=${route.query} />`; break;
    case 'settings': view = html`<${Settings} />`; break;
    case 'more': view = html`<${More} />`; break;
    default: view = html`<${Today} />`;
  }
  return html`<${AppCtx.Provider} value=${{ state, refresh }}>
    <${Shell} state=${state} section=${section === '' ? 'today' : section} counts=${counts}>
      ${connectionError && html`<div class="banner"><span class="spinner"></span><span class="grow">Reconnecting to Nelson OS… If this lasts more than a minute, close Nelson OS and open it again from the desktop icon.</span><button class="btn sm" onClick=${refresh}>Try now</button></div>`}
      <${ScreenGuard} key=${route.path}>${view}</${ScreenGuard}>
    </${Shell}>
    <${Toaster} />
  </${AppCtx.Provider}>`;
}

// Outlook sign-in returns to "/?connected=outlook#/..."; tidy the URL.
if (location.search.includes('connected=')) history.replaceState(null, '', `/${location.hash}`);
render(html`<${App} />`, document.getElementById('app'));
