import { html, useState, useEffect, api, useApi, useApp, useRoute, go, toast, toastErr, fmtDate, ago, label, Drawer, Busy, Loading, ProjectChip } from './lib.js';

const FILTERS = [
  ['me', 'Needs your reply'],
  ['them', 'Waiting on them'],
  ['', 'All work email'],
  ['done', 'Done'],
];

function ThreadDrawer({ id, onClose, onChange }) {
  const { state } = useApp();
  const { data: t, reload } = useApi(`/threads/${id}`);
  const [reply, setReply] = useState(null);
  const [busy, setBusy] = useState(null);
  const [atts, setAtts] = useState({});
  useEffect(() => { if (t) setReply(t.suggested_reply || ''); }, [t?.id, t?.suggested_reply]);
  if (!t) return html`<${Drawer} title="Loading…" onClose=${onClose}><${Loading} /></${Drawer}>`;

  const patch = async (body, msg) => { try { await api(`/threads/${id}`, { method: 'PATCH', body }); if (msg) toast(msg); reload(); onChange(); } catch (e) { toastErr(e); } };
  const rewrite = async () => {
    setBusy('ai');
    try { const r = await api(`/threads/${id}/suggest-reply`, { method: 'POST', body: {} }); setReply(r.reply); } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const draft = async () => {
    setBusy('draft');
    try { const d = await api(`/threads/${id}/draft`, { method: 'POST', body: { body: reply } }); go(`#/drafts/${d.id}`); } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const askAbout = () => go(`#/ask?q=${encodeURIComponent(`Help me handle the email "${t.subject}" (thread ${t.id}). Check the drawings, takeoffs and logs, then draft the reply.`)}&project=${t.project_id || ''}`);
  const loadAtts = async (emailId) => { try { setAtts({ ...atts, [emailId]: await api(`/emails/${emailId}/attachments`) }); } catch (e) { toastErr(e); } };
  const importAtt = async (emailId, a) => {
    if (!t.project_id) return toastErr(new Error('Assign this conversation to a project first.'));
    try { await api(`/emails/${emailId}/attachments/${a.id}/import`, { method: 'POST', body: { project_id: t.project_id } }); toast(`${a.name} added to project documents`); } catch (e) { toastErr(e); }
  };

  return html`<${Drawer} title=${t.subject} sub=${html`${t.project ? html`<${ProjectChip} name=${t.project} id=${t.project_id} />` : 'No project'} · ${label(t.category || 'general')} · ${t.message_count} message${t.message_count === 1 ? '' : 's'}`} onClose=${onClose}
    foot=${html`
      ${t.status === 'open' ? html`<button class="btn" onClick=${() => patch({ status: 'done' }, 'Marked done')}>Mark done</button>` : html`<button class="btn" onClick=${() => patch({ status: 'open' }, 'Reopened')}>Reopen</button>`}
      <button class="btn" onClick=${askAbout}>Ask Nelson OS</button>
      <${Busy} class="btn primary" on=${busy === 'draft'} onClick=${draft} disabled=${!reply}>Create reply draft</${Busy}>`}>
    <div class="stack" style="gap:16px">
      ${t.summary && html`<div><div class="small muted">Summary</div><p>${t.summary}</p></div>`}
      <div class="grid2">
        <label class="field">Ball in court
          <select class="input" value=${t.ball} onChange=${(e) => patch({ ball: e.target.value })}>
            <option value="me">Waiting on me</option><option value="them">Waiting on them</option><option value="none">Nothing pending</option>
          </select></label>
        <label class="field">Project
          <select class="input" value=${t.project_id || ''} onChange=${(e) => patch({ project_id: e.target.value || null }, 'Project updated')}>
            <option value="">No project</option>${state.projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
          </select></label>
      </div>
      ${t.next_action && html`<div class="next"><div><b>Next:</b> ${t.next_action}</div></div>`}
      ${t.related?.length ? html`<div><div class="small muted" style="margin-bottom:4px">Logged from this conversation</div>${t.related.map((r) => html`<div class="row small" style="padding:3px 0"><span class="chip">${label(r.type).replace(/s$/, '')}</span><a href=${t.project_id ? `#/projects/${t.project_id}/${{ rfis: 'rfis', submittals: 'submittals', orders: 'procurement', changes: 'budget' }[r.type] || 'overview'}?open=${r.id}` : null}>${r.label}</a>${r.review ? html`<span class="chip review">Found in email</span>` : null}</div>`)}</div>` : null}
      <div>
        <div class="spread" style="margin-bottom:6px"><b>${t.ball === 'me' ? 'Suggested reply' : 'Reply'}</b>
          <${Busy} class="btn sm" on=${busy === 'ai'} onClick=${rewrite}>${reply ? 'Rewrite with AI' : 'Write with AI'}</${Busy}></div>
        <textarea class="input" rows="9" value=${reply ?? ''} onInput=${(e) => setReply(e.target.value)} placeholder="Write a reply, or let Nelson OS draft one."></textarea>
        <p class="tiny muted" style="margin-top:4px">Nothing is sent from here. Create a draft, then open it in Outlook to send.</p>
      </div>
      <div>
        <b>Messages</b>
        <div style="margin-top:8px">${t.emails.map((e) => html`<div class=${`msg${e.from_me ? ' me' : ''}`}>
          <div class="spread small"><span><b>${e.from_me ? 'You' : e.from_name || e.from_email}</b> <span class="muted">to ${(e.to || []).map((a) => a.name || a.email).join(', ')}</span></span><span class="muted nowrap">${fmtDate(e.received_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
          <pre>${e.body}</pre>
          <div class="row small" style="margin-top:8px">
            ${e.web_link && html`<a href=${e.web_link} target="_blank" rel="noopener">Open in Outlook</a>`}
            ${e.has_attachments ? (atts[e.id] ? atts[e.id].map((a) => html`<button class="btn sm" onClick=${() => importAtt(e.id, a)} title="Add to project documents">${a.name}</button>`) : html`<button class="btn sm" onClick=${() => loadAtts(e.id)}>Show attachments</button>`) : null}
          </div>
        </div>`)}</div>
      </div>
    </div>
  </${Drawer}>`;
}

export function Inbox({ openId }) {
  const route = useRoute();
  const { state } = useApp();
  const [filter, setFilter] = useState(route.query.ball ?? 'me');
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const query = new URLSearchParams({ ...(filter === 'done' ? { status: 'done' } : filter ? { ball: filter } : {}), ...(project ? { project_id: project } : {}), ...(q ? { q } : {}) });
  const { data, loading, reload } = useApi(`/threads?${query}`, [state.sync.finishedAt]);
  return html`<div class="page">
    <div class="page-head"><div><h1>Inbox</h1><p class="muted">Work email from Outlook, sorted by who owes the next step.</p></div>
      ${state.microsoft.connected ? html`<button class="btn" onClick=${() => api('/sync/mail', { method: 'POST' }).then(() => toast('Checking Outlook')).catch(toastErr)}>Check now</button>` : html`<a class="btn primary" href="#/connections">Connect Outlook</a>`}</div>
    <div class="row wrap" style="margin-bottom:14px">
      <div class="seg" role="tablist">${FILTERS.map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
      <select class="input" style="width:auto" value=${project} onChange=${(e) => setProject(e.target.value)} aria-label="Project"><option value="">All projects</option>${state.projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
      <input class="input grow" style="min-width:180px" placeholder="Search email" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    <div class="items">
      ${loading && !data ? html`<${Loading} />` : !data?.length ? html`<div class="empty"><b>${filter === 'me' ? 'No one is waiting on you' : 'Nothing here'}</b>${state.microsoft.connected ? 'New email is checked every 10 minutes.' : 'Connect Outlook to see your email here.'}</div>` :
        data.map((t) => html`<button class="thread-row" onClick=${() => go(`#/inbox/${encodeURIComponent(t.id)}`)}>
          <div class="who">${t.waiting_on || '—'}</div>
          <div class="mid" style="min-width:0"><div class="row" style="gap:8px;flex-wrap:wrap"><span class="subj">${t.subject}</span>${t.project && html`<span class="chip project">${t.project}</span>`}${t.urgency >= 2 && html`<span class="chip high">Urgent</span>`}${t.suggested_reply && t.ball === 'me' ? html`<span class="chip ok">Reply drafted</span>` : null}</div><div class="sum">${t.summary || t.next_action || ''}</div></div>
          <div class="small muted nowrap">${ago(t.last_at)}</div>
        </button>`)}
    </div>
    ${openId && html`<${ThreadDrawer} id=${openId} onClose=${() => go('#/inbox')} onChange=${reload} />`}
  </div>`;
}
