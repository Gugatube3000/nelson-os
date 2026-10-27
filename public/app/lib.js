import { html, render, useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from '/vendor/htm-preact.mjs';

export { html, render, useState, useEffect, useRef, useMemo, useCallback, createContext, useContext };

// ---------- API ----------
export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'X-Requested-With': 'nelson-os', ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.hash = '#/login'; throw new Error('Enter your passcode.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || `Request failed (${res.status})`);
  return data;
}

/** Fetch data for a component; re-runs when deps change. */
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    api(path).then((data) => setState({ data, error: null, loading: false })).catch((error) => setState({ data: null, error, loading: false }));
  }, [path]);
  useEffect(load, [path, ...deps]);
  return { ...state, reload: load };
}

/** Stream a chat turn: onStep for progress, resolves with the final result. */
export async function streamChat(body, onStep) {
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nelson-os' }, body: JSON.stringify(body) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (!ev || !data) continue;
      const parsed = JSON.parse(data);
      if (ev === 'step') onStep?.(parsed);
      if (ev === 'done') result = parsed;
      if (ev === 'error') throw new Error(parsed.message);
    }
  }
  return result;
}

// ---------- routing ----------
export function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const [path, query = ''] = hash.slice(1).split('?');
  return { path: path || '/', parts: (path || '/').split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(query)) };
}
export const go = (to) => { location.hash = to; };

// ---------- app context ----------
export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// ---------- toast ----------
let toastSet = null;
export function Toaster() {
  const [t, setT] = useState(null);
  toastSet = setT;
  useEffect(() => { if (!t) return undefined; const id = setTimeout(() => setT(null), t.err ? 6000 : 3200); return () => clearTimeout(id); }, [t]);
  return t ? html`<div class=${`toast${t.err ? ' err' : ''}`} role="status">${t.msg}</div>` : null;
}
export const toast = (msg) => toastSet?.({ msg });
export const toastErr = (e) => toastSet?.({ msg: e?.message || String(e), err: true });

// ---------- formatting ----------
const parseDate = (d) => (d ? new Date(String(d).length <= 10 ? `${d}T12:00:00` : d) : null);
export const fmtDate = (d, opts = { month: 'short', day: 'numeric' }) => (d ? parseDate(d).toLocaleDateString('en-US', opts) : '—');
export const fmtDay = (d) => (d ? parseDate(d).toLocaleDateString('en-US', { weekday: 'short' }) : '');
export const fmtMoney = (n) => (n == null || n === '' ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
export const todayIso = () => new Date().toLocaleDateString('en-CA');
export function ago(d) {
  if (!d) return '';
  const days = Math.round((new Date(todayIso()) - new Date(String(d).slice(0, 10))) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
export function until(d) {
  if (!d) return '';
  const days = Math.round((new Date(String(d).slice(0, 10)) - new Date(todayIso())) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days late`;
}
export const label = (s) => String(s || '').replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
export const rfiNo = (n) => `RFI-${String(n ?? '').padStart(3, '0')}`;

// Minimal, safe markdown: paragraphs, bullets, **bold**, `code`.
export function Markdown({ text }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const blocks = [];
  let list = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) { list = list || []; list.push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { blocks.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) blocks.push(`<p><b>${inline(h[1])}</b></p>`);
    else if (line.trim()) blocks.push(`<p>${inline(line)}</p>`);
  }
  if (list) blocks.push(`<ul>${list.join('')}</ul>`);
  return html`<div class="md" dangerouslySetInnerHTML=${{ __html: blocks.join('') }}></div>`;
}

// ---------- UI pieces ----------
export function Drawer({ title, sub, onClose, children, foot }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  return html`
    <div class="scrim" onClick=${onClose}></div>
    <aside class="drawer" role="dialog" aria-label=${typeof title === 'string' ? title : 'Details'}>
      <div class="drawer-head">
        <div class="grow"><h2>${title}</h2>${sub && html`<div class="muted small" style="margin-top:3px">${sub}</div>`}</div>
        <button class="btn ghost sm" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      <div class="drawer-body">${children}</div>
      ${foot && html`<div class="drawer-foot">${foot}</div>`}
    </aside>`;
}

export function Busy({ on, children, ...props }) {
  return html`<button ...${props} disabled=${on || props.disabled}>${on ? html`<span class="spinner"></span>` : null}${children}</button>`;
}

export function Loading() {
  return html`<div class="empty"><span class="spinner"></span></div>`;
}

export function ErrorNote({ error }) {
  return error ? html`<div class="banner">${error.message || String(error)}</div>` : null;
}

export function Sev({ s }) {
  return html`<span class=${`chip ${s === 'high' ? 'high' : s === 'medium' ? 'medium' : ''}`}>${s === 'high' ? 'High' : s === 'medium' ? 'Medium' : 'Low'}</span>`;
}

export function ProjectChip({ name, id }) {
  return name ? html`<a class="chip project" href=${id ? `#/projects/${id}` : undefined} onClick=${(e) => e.stopPropagation()}>${name}</a>` : null;
}

const svg = (d, extra = '') => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: d + extra }}></svg>`;
export const Icon = {
  today: svg('<rect x="3.5" y="4.5" width="17" height="16" rx="1.5"/><path d="M3.5 9.5h17M8 3v3M16 3v3M7.5 13.5h4"/>'),
  inbox: svg('<path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5"/><path d="M5.5 5.5h13l2 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-5z"/>'),
  projects: svg('<path d="M3.5 20.5h17M5.5 20.5V9l6.5-4.5L18.5 9v11.5"/><path d="M9.5 20.5v-5h5v5"/>'),
  ask: svg('<path d="M4.5 5.5h15v10h-8l-4.5 4v-4h-2.5z"/><path d="M9 10.5h6"/>'),
  drafts: svg('<path d="M4 6.5l8 6 8-6"/><rect x="3.5" y="5" width="17" height="14" rx="1.5"/>'),
  activity: svg('<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>'),
  plug: svg('<path d="M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0zM12 17v3.5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2 1.2L10 21h4l.5-2.5a7 7 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>'),
  rules: svg('<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M14.5 3.5V7.5h4M9 12h6M9 15.5h6"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="M4 12l16-7-6.5 15-2.5-6.5z"/>'),
  file: svg('<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M13.5 3.5v4.5h4.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  refresh: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15"/>'),
  outlook: svg('<path d="M4 6.5l8 6 8-6"/><rect x="3.5" y="5" width="17" height="14" rx="1.5"/>'),
};
