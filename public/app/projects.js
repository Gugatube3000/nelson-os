import { html, useState, useEffect, useRef, api, useApi, useApp, useRoute, go, toast, toastErr, fmtDate, fmtMoney, ago, todayIso, Busy, Loading, ErrorNote, Markdown } from './lib.js';
import { LogTable, RecordDrawer } from './records.js';
import { RiskCard } from './today.js';

const TABS = [
  ['overview', 'Overview'], ['rfis', 'RFIs'], ['submittals', 'Submittals'], ['procurement', 'Orders and takeoffs'], ['schedule', 'Schedule'],
  ['budget', 'Budget'], ['permits', 'Permits'], ['documents', 'Drawings and docs'], ['email', 'Email'], ['contacts', 'Contacts'], ['activity', 'Activity'],
];

export function Projects() {
  const { data, loading, reload } = useApi('/briefing');
  const [adding, setAdding] = useState(false);
  if (!data) return html`<div class="page">${loading && html`<${Loading} />`}</div>`;
  return html`<div class="page">
    <div class="page-head"><div><h1>Projects</h1><p class="muted">${data.projects.length} active</p></div><button class="btn primary" onClick=${() => setAdding(true)}>Add project</button></div>
    ${data.projects.length ? html`<div class="cards">${[...data.projects].sort((a, b) => b.risks.high - a.risks.high || b.risks.medium - a.risks.medium).map((p) => html`<a class="pcard" href=${`#/projects/${p.id}`}>
      <div class="spread" style="align-items:flex-start"><div><h2>${p.name}</h2><div class="small muted">${[p.address, p.city].filter(Boolean).join(', ') || 'No address yet'}</div></div>
        ${p.risks.high ? html`<span class="chip high">${p.risks.high} high</span>` : p.risks.medium ? html`<span class="chip medium">${p.risks.medium} to watch</span>` : html`<span class="chip ok">On track</span>`}</div>
      <div class="row wrap" style="gap:6px">${p.phase && html`<span class="chip">${p.phase}</span>`}${p.procore_id ? html`<span class="chip ok">Procore</span>` : null}${p.review ? html`<span class="chip review">Found in email</span>` : null}${p.source === 'demo' ? html`<span class="chip">Sample</span>` : null}</div>
      <div class="nums">
        <div><b>${p.counts.replyOwed}</b>need a reply</div>
        <div><b>${p.counts.openRfis}</b>open RFIs</div>
        <div><b>${p.counts.openSubmittals}</b>submittals</div>
        <div><b>${p.counts.openOrders}</b>orders</div>
      </div>
    </a>`)}</div>` : html`<div class="panel empty"><b>No projects yet</b>Connect Outlook and Nelson OS will find them in your email, or add one yourself.</div>`}
    ${adding && html`<${RecordDrawer} entity="projects" onClose=${() => setAdding(false)} onSaved=${(p) => { reload(); if (p?.id) go(`#/projects/${p.id}`); }} />`}
  </div>`;
}

function Overview({ o, reload }) {
  const p = o.project;
  const b = o.budget;
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const ask = (e) => { e.preventDefault(); if (q.trim()) go(`#/ask?q=${encodeURIComponent(q)}&project=${p.id}`); };
  const dismiss = async (key) => { await api('/risks/dismiss', { method: 'POST', body: { key, days: 7 } }); reload(); };
  const prompts = ['What is holding up this project?', 'Write this week’s owner update', 'Draft a 3-week lookahead email for the subs', 'What should I order in the next two weeks?'];
  return html`<div class="today" style="margin-top:0">
    <section>
      <form class="row" onSubmit=${ask} style="margin-bottom:10px"><input class="input" placeholder=${`Ask anything about ${p.name}`} value=${q} onInput=${(e) => setQ(e.target.value)} /><button class="btn dark">Ask</button></form>
      <div class="prompts" style="margin:0 0 22px">${prompts.map((t) => html`<button type="button" onClick=${() => go(`#/ask?q=${encodeURIComponent(t)}&project=${p.id}`)}>${t}</button>`)}</div>
      <h2 style="margin-bottom:10px">Needs attention</h2>
      ${o.briefing.risks.length ? o.briefing.risks.map((r) => html`<${RiskCard} key=${r.key} r=${r} onDismiss=${dismiss} inProject />`) : html`<div class="panel empty"><b>Nothing at risk</b>RFIs, submittals, orders, schedule and permits all look on track.</div>`}
    </section>
    <aside>
      <div class="ball"><div class="spread" style="margin-bottom:8px"><h2>Project</h2><button class="btn sm ghost" onClick=${() => setEditing(true)}>Edit</button></div>
        <div class="panel" style="padding:14px 16px"><dl class="kv">
          <dt>Address</dt><dd>${[p.address, p.city].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Type</dt><dd>${p.type || '—'}</dd><dt>Phase</dt><dd>${p.phase || '—'}</dd>
          <dt>Target completion</dt><dd>${fmtDate(p.target_completion, { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
        </dl></div></div>
      <div class="ball"><h2 style="margin-bottom:8px">Money</h2><div class="panel" style="padding:14px 16px"><dl class="kv">
        <dt>Contract</dt><dd>${fmtMoney(b.contract)}</dd><dt>Budget</dt><dd>${fmtMoney(b.budget)}</dd>
        <dt>Committed</dt><dd>${fmtMoney(b.committed)}</dd><dt>Approved changes</dt><dd>${fmtMoney(b.approvedChanges)}</dd>
        <dt>Pending changes</dt><dd>${fmtMoney(b.pendingChanges)}</dd>
        <dt>Contingency left</dt><dd class=${b.contingencyRemaining != null && b.pendingChanges > b.contingencyRemaining ? 'late' : ''} style=${b.contingencyRemaining != null && b.pendingChanges > b.contingencyRemaining ? 'color:var(--maroon-ink);font-weight:600' : ''}>${fmtMoney(b.contingencyRemaining)}</dd>
      </dl></div></div>
      <div class="ball"><h2 style="margin-bottom:8px">Next three weeks</h2><div class="items">${o.briefing.lookahead.length ? o.briefing.lookahead.slice(0, 8).map((l) => html`<div class="look"><div class="d">${l.date < todayIso() ? 'Now' : fmtDate(l.date)}</div><div><div style="font-weight:550">${l.title}</div><div class="small muted">${l.who || ''}</div></div></div>`) : html`<div class="empty">Nothing scheduled.</div>`}</div></div>
    </aside>
    ${editing && html`<${RecordDrawer} entity="projects" id=${p.id} onClose=${() => setEditing(false)} onSaved=${reload} />`}
  </div>`;
}

function Gantt({ projectId }) {
  const { data } = useApi(`/records/schedule_items?project_id=${projectId}`);
  const { data: risks } = useApi(`/risks?project_id=${projectId}`);
  const blocked = new Set((risks || []).filter((r) => r.rule === 'activity_blocked' || r.rule === 'activity_late').map((r) => r.key.split(':')[1]));
  if (!data?.length) return null;
  const start = new Date();
  start.setDate(start.getDate() - start.getDay() + 1 - 7); // Monday of last week
  const days = 42;
  const pos = (d) => Math.round((new Date(`${d}T12:00:00`) - start) / 86400000);
  const rows = data.filter((a) => a.start && pos(a.finish || a.start) >= 0 && pos(a.start) < days);
  if (!rows.length) return null;
  const todayX = (pos(new Date().toLocaleDateString('en-CA')) / days) * 100;
  return html`<div class="panel" style="padding:14px 16px;margin-bottom:22px;overflow-x:auto">
    <div class="spread" style="margin-bottom:10px"><h3>Six-week view</h3><span class="small muted"><span class="dot" style="background:var(--maroon)"></span> Blocked or late</span></div>
    <div style="min-width:560px;position:relative">
      <div style="display:grid;grid-template-columns:200px repeat(6,1fr);font-size:12px;color:var(--graphite);margin-bottom:4px"><span></span>${[0, 1, 2, 3, 4, 5].map((w) => { const d = new Date(start); d.setDate(d.getDate() + w * 7); return html`<span style="border-left:1px solid var(--rule);padding-left:4px">${fmtDate(d.toLocaleDateString('en-CA'))}</span>`; })}</div>
      <div style=${`position:absolute;top:0;bottom:0;left:calc(200px + (100% - 200px) * ${todayX / 100});width:2px;background:var(--maroon);opacity:.6`} title="Today"></div>
      ${rows.map((a) => {
        const s = Math.max(0, pos(a.start));
        const e = Math.min(days, pos(a.finish || a.start) + 1);
        const color = a.status === 'complete' ? 'var(--stamp)' : a.status === 'delayed' || blocked.has(a.id) ? 'var(--maroon)' : a.status === 'in_progress' ? 'var(--ink)' : 'var(--graphite)';
        return html`<div style="display:grid;grid-template-columns:200px 1fr;align-items:center;height:28px">
          <div class="small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px">${a.name}</div>
          <div style="position:relative;height:100%"><div style=${`position:absolute;top:8px;height:12px;border-radius:3px;left:${(s / days) * 100}%;width:${Math.max(1.2, ((e - s) / days) * 100)}%;background:${color};opacity:${a.status === 'not_started' && !blocked.has(a.id) ? 0.45 : 0.9}`}></div></div>
        </div>`;
      })}
    </div>
  </div>`;
}

function ScheduleTab({ p, open, reload }) {
  const file = useRef();
  const importCsv = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const r = await api(`/projects/${p.id}/schedule/import`, { method: 'POST', body: { csv: await f.text() } }); toast(`Imported ${r.imported} activities`); reload(); } catch (x) { toastErr(x); }
    e.target.value = '';
  };
  return html`<div>
    <div class="row wrap" style="margin-bottom:14px">
      <button class="btn" onClick=${() => go(`#/ask?q=${encodeURIComponent('Draft a 3-week lookahead email to the subs: what starts, what each trade needs from us, and what is blocking.')}&project=${p.id}`)}>Draft lookahead email to subs</button>
      <button class="btn" onClick=${() => file.current.click()}>Import from Excel (CSV)</button>
      <input type="file" accept=".csv,text/csv" ref=${file} class="hidden" onChange=${importCsv} />
      <span class="small muted">Export your schedule from Excel or MS Project as CSV with Name, Start and Finish columns.</span>
    </div>
    <${Gantt} projectId=${p.id} />
    <${LogTable} entity="schedule_items" projectId=${p.id} openId=${open} onChanged=${reload} />
    <${LogTable} entity="inspections" projectId=${p.id} onChanged=${reload} compact />
  </div>`;
}

function DocumentsTab({ p, connected }) {
  const { data: docs, reload } = useApi(`/records/documents?project_id=${p.id}`);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState({});
  const [odq, setOdq] = useState('');
  const [od, setOd] = useState(null);
  const file = useRef();
  useEffect(() => {
    if (!docs?.some((d) => d.status === 'indexing')) return undefined;
    const id = setTimeout(reload, 2500);
    return () => clearTimeout(id);
  }, [docs]);
  const upload = async (files) => {
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name)) { toastErr(new Error(`${f.name}: only PDFs for now`)); continue; }
      try {
        const res = await fetch(`/api/projects/${p.id}/documents`, { method: 'POST', headers: { 'X-Requested-With': 'nelson-os', 'X-Filename': encodeURIComponent(f.name), 'Content-Type': 'application/pdf' }, body: f });
        if (!res.ok) throw new Error((await res.json()).error);
        toast(`${f.name} added. Reading it now.`);
      } catch (e) { toastErr(e); }
    }
    reload();
  };
  const ask = async (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setAnswer(null);
    try { setAnswer(await api('/ask-drawings', { method: 'POST', body: { project_id: p.id, question: q } })); } catch (x) { toastErr(x); } finally { setBusy(false); }
  };
  const showPages = async (d) => setPages({ ...pages, [d.id]: pages[d.id] ? null : await api(`/documents/${d.id}/pages`) });
  const searchOd = async (e) => { e.preventDefault(); try { setOd(await api(`/onedrive/search?q=${encodeURIComponent(odq)}`)); } catch (x) { toastErr(x); } };
  const importOd = async (item) => { try { await api('/onedrive/import', { method: 'POST', body: { ...item, itemId: item.id, project_id: p.id } }); toast(`${item.name} added`); reload(); } catch (x) { toastErr(x); } };

  return html`<div class="today" style="margin-top:0">
    <section>
      <div class="panel" style="padding:16px;margin-bottom:20px">
        <h2 style="margin-bottom:4px">Ask the drawings</h2>
        <p class="small muted" style="margin-bottom:10px">Quantities, dimensions, fixture counts, details, notes. Answers cite the sheet and page.</p>
        <form class="row" onSubmit=${ask}><input class="input" placeholder="How many 30-inch vanities are there, and is anything unresolved?" value=${q} onInput=${(e) => setQ(e.target.value)} /><${Busy} class="btn dark" on=${busy}>Ask</${Busy}></form>
        ${busy && html`<p class="small muted" style="margin-top:10px">Reading the relevant sheets…</p>`}
        ${answer && html`<div style="margin-top:14px"><${Markdown} text=${answer.answer} />
          ${answer.sources?.length ? html`<div class="small muted" style="margin-top:8px">Sheets read: ${answer.sources.map((s, i) => html`${i ? ', ' : ''}<a href=${`/api/documents/${s.doc_id}/page/${s.page}`} target="_blank">${s.sheet || `page ${s.page}`}</a>`)}</div>` : null}</div>`}
      </div>
      <h2 style="margin-bottom:10px">Documents <span class="muted small" style="font-weight:500">${docs?.length || 0}</span></h2>
      <div class=${`dropzone${over ? ' over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
        onDrop=${(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}>
        Drop drawing sets, specs or takeoffs here (PDF), or <button class="btn sm" onClick=${() => file.current.click()}>choose files</button>
        <input type="file" accept="application/pdf" multiple ref=${file} class="hidden" onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </div>
      <div class="items" style="margin-top:12px">${(docs || []).map((d) => html`<div style="border-top:1px solid var(--rule-soft)">
        <div class="item" style="cursor:default">
          <div class="grow"><a href=${`/api/documents/${d.id}/file`} target="_blank" style="font-weight:600">${d.filename}</a>
            <div class="small muted">${d.status === 'indexing' ? html`<span class="spinner" style="width:12px;height:12px;vertical-align:-2px"></span> Reading pages…` : d.status === 'error' ? `Couldn't read: ${d.error}` : `${d.pages} pages${d.discipline ? ` · ${d.discipline}` : ''}`}</div></div>
          ${d.status === 'ready' && html`<button class="btn sm ghost" onClick=${() => showPages(d)}>${pages[d.id] ? 'Hide sheets' : 'Sheets'}</button>`}
          ${d.status === 'error' && html`<button class="btn sm" onClick=${() => api(`/documents/${d.id}/reindex`, { method: 'POST' }).then(reload).catch(toastErr)}>Try again</button>`}
        </div>
        ${pages[d.id] && html`<div style="padding:0 14px 10px" class="row wrap">${pages[d.id].map((pg) => html`<a class="chip project" href=${`/api/documents/${d.id}/page/${pg.page}`} target="_blank" title=${pg.title || ''}>${pg.sheet || `p.${pg.page}`}</a>`)}</div>`}
      </div>`)}</div>
    </section>
    <aside>
      ${connected ? html`<div class="panel" style="padding:16px"><h3 style="margin-bottom:8px">Add from OneDrive or SharePoint</h3>
        <form class="row" onSubmit=${searchOd}><input class="input" placeholder="Search for a drawing set" value=${odq} onInput=${(e) => setOdq(e.target.value)} /><button class="btn">Search</button></form>
        ${od && html`<div class="stack" style="gap:6px;margin-top:10px">${od.length ? od.map((it) => html`<div class="row small"><span class="grow" title=${it.path}>${it.name}</span><button class="btn sm" onClick=${() => importOd(it)}>Add</button></div>`) : html`<span class="small muted">No PDFs found.</span>`}</div>`}
      </div>` : html`<div class="panel" style="padding:16px"><p class="small muted">Connect OneDrive & SharePoint on the Connections page to pull drawing sets straight from your files.</p></div>`}
    </aside>
  </div>`;
}

function EmailTab({ p }) {
  const { data } = useApi(`/threads?project_id=${p.id}&status=open`);
  if (!data) return html`<${Loading} />`;
  return html`<div class="items">${data.length ? data.map((t) => html`<button class="thread-row" onClick=${() => go(`#/inbox/${encodeURIComponent(t.id)}`)}>
    <div class="who">${t.waiting_on || '—'}</div><div class="mid"><div class="subj">${t.subject}</div><div class="sum">${t.summary || ''}</div></div>
    <div class="small muted nowrap">${t.ball === 'me' ? 'Waiting on you' : t.ball === 'them' ? 'Waiting on them' : ''} · ${ago(t.last_at)}</div></button>`) : html`<div class="empty">No open email for this project.</div>`}</div>`;
}

export function ActivityList({ items }) {
  if (!items?.length) return html`<div class="items"><div class="empty">Nothing yet.</div></div>`;
  return html`<div class="items">${items.map((a) => html`<div class="item" style="cursor:default">
    <div style="width:84px;flex:none" class="small muted">${fmtDate(a.at)}<br />${new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
    <div class="grow"><div><span class=${`chip${a.actor === 'agent' ? ' ok' : ''}`}>${a.actor === 'agent' ? 'Nelson OS' : a.actor === 'user' ? 'You' : 'System'}</span> <b>${a.title}</b>${a.project ? html` <span class="small muted">· ${a.project}</span>` : ''}</div>
      ${a.detail && html`<div class="small muted">${a.detail}</div>`}
      ${a.why && html`<div class="small" style="margin-top:2px"><span class="muted">Why:</span> ${a.why}</div>`}
      ${a.sources?.length ? html`<div class="tiny muted" style="margin-top:2px">From: ${a.sources.map((s) => s.label).join(', ')}</div>` : null}
    </div></div>`)}</div>`;
}

export function ProjectPage({ id, tab }) {
  const { state } = useApp();
  const route = useRoute();
  const { data: o, error, reload } = useApi(`/projects/${id}/overview`);
  if (error) return html`<div class="page"><${ErrorNote} error=${error} /></div>`;
  if (!o) return html`<div class="page"><${Loading} /></div>`;
  const p = o.project;
  const open = route.query.open;
  const confirm = async () => { await api(`/records/projects/${p.id}/confirm`, { method: 'POST' }); toast('Project confirmed'); reload(); };
  const count = { rfis: o.counts.openRfis, submittals: o.counts.openSubmittals, procurement: o.counts.openOrders, documents: o.counts.documents, email: o.counts.replyOwed };
  let body;
  switch (tab) {
    case 'rfis': body = html`<${LogTable} entity="rfis" projectId=${p.id} openId=${open} onChanged=${reload} />`; break;
    case 'submittals': body = html`<${LogTable} entity="submittals" projectId=${p.id} openId=${open} onChanged=${reload} />`; break;
    case 'procurement': body = html`<${LogTable} entity="orders" projectId=${p.id} openId=${open} onChanged=${reload} /><${LogTable} entity="takeoffs" projectId=${p.id} onChanged=${reload} />`; break;
    case 'schedule': body = html`<${ScheduleTab} p=${p} open=${open} reload=${reload} />`; break;
    case 'budget': body = html`<${LogTable} entity="changes" projectId=${p.id} openId=${open} onChanged=${reload} />`; break;
    case 'permits': body = html`<${LogTable} entity="permits" projectId=${p.id} openId=${open} onChanged=${reload} /><${LogTable} entity="inspections" projectId=${p.id} onChanged=${reload} />`; break;
    case 'documents': body = html`<${DocumentsTab} p=${p} connected=${state.microsoft.connected && state.microsoft.files} />`; break;
    case 'email': body = html`<${EmailTab} p=${p} />`; break;
    case 'contacts': body = html`<${LogTable} entity="contacts" projectId=${p.id} openId=${open} />`; break;
    case 'activity': body = html`<${ActivityList} items=${o.activity} />`; break;
    default: body = html`<${Overview} o=${o} reload=${reload} />`;
  }
  return html`<div class="page">
    <div class="page-head" style="margin-bottom:0"><div>
      <div class="small"><a href="#/projects" class="muted">Projects</a></div>
      <h1>${p.name}</h1><p class="muted">${[[p.address, p.city].filter(Boolean).join(', '), p.phase].filter(Boolean).join(' · ')}</p></div>
      ${p.ext_url ? html`<a class="btn" href=${p.ext_url} target="_blank" rel="noopener">Open in Procore</a>` : null}
      ${p.review ? html`<div class="row"><span class="chip review">Found in email</span><button class="btn sm primary" onClick=${confirm}>Confirm project</button></div>` : null}
    </div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href=${`#/projects/${p.id}/${k}`} class=${(tab || 'overview') === k ? 'on' : ''}>${l}${count[k] ? html`<span class="n">${count[k]}</span>` : null}</a>`)}</nav>
    ${body}
  </div>`;
}
