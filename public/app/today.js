import { html, useState, api, useApi, useApp, go, toast, toastErr, fmtDate, fmtDay, ago, until, todayIso, Loading, ErrorNote, Sev, ProjectChip, Busy } from './lib.js';

// New answers, returns, slips and items found in email since you last looked.
function Changes({ items }) {
  if (!items.length) return null;
  const open = (c) => {
    if (c.entity_type === 'threads') return go(`#/inbox/${encodeURIComponent(c.entity_id)}`);
    if (c.project_id && TAB_FOR[c.entity_type]) return go(`#/projects/${c.project_id}/${TAB_FOR[c.entity_type]}?open=${c.entity_id}`);
    if (c.project_id) return go(`#/projects/${c.project_id}`);
    return go('#/activity');
  };
  return html`<div class="ball"><h2>What changed <span class="n">last 3 days</span></h2>
    <div class="items">${items.slice(0, 8).map((c) => html`<button class="item" onClick=${() => open(c)}>
      <div class="grow"><div class="what" style="color:var(--ink)">${c.title}</div>${c.project && html`<div class="small muted">${c.project}${c.kind === 'detected' ? ' · found in email' : ' · Procore'}</div>`}</div>
      <div class="age">${ago(c.at)}</div>
    </button>`)}
    ${items.length > 8 ? html`<a class="item small muted" href="#/activity">${items.length - 8} more in Activity</a>` : null}</div></div>`;
}

const TAB_FOR = { rfis: 'rfis', submittals: 'submittals', orders: 'procurement', takeoffs: 'procurement', schedule_items: 'schedule', changes: 'budget', permits: 'permits', inspections: 'permits', projects: 'overview' };

export function sourceHref(s, projectId) {
  if (s.type === 'threads') return `#/inbox/${encodeURIComponent(s.id)}`;
  if (s.type === 'drafts') return `#/drafts/${s.id}`;
  if (projectId && TAB_FOR[s.type]) return `#/projects/${projectId}/${TAB_FOR[s.type]}?open=${s.id}`;
  return null;
}

export async function runRiskAction(a) {
  let draft;
  if (a.kind === 'reply') return go(`#/inbox/${encodeURIComponent(a.id)}`);
  if (a.kind === 'followup') draft = await api('/followup', { method: 'POST', body: { type: a.type, id: a.id } });
  if (a.kind === 'transmit') draft = await api(`/submittals/${a.id}/prepare`, { method: 'POST' });
  if (a.kind === 'send') draft = await api(`/rfis/${a.id}/prepare`, { method: 'POST' });
  if (draft) go(`#/drafts/${draft.id}`);
}

export function RiskCard({ r, onDismiss, inProject }) {
  const [busy, setBusy] = useState(null);
  const run = async (a) => { setBusy(a.label); try { await runRiskAction(a); } catch (e) { toastErr(e); } finally { setBusy(null); } };
  const ask = () => go(`#/ask?q=${encodeURIComponent(`${r.project ? `${r.project}: ` : ''}${r.title}. What exactly should I do next, and draft whatever I need to send?`)}&project=${r.project_id || ''}`);
  return html`<article class=${`risk ${r.severity}`}>
    <div class="meta"><${Sev} s=${r.severity} />${!inProject && html`<${ProjectChip} name=${r.project} id=${r.project_id} />`}${r.owner && html`<span class="small muted">Owner: ${r.owner}</span>`}</div>
    <h3>${r.title}</h3>
    ${r.detail && html`<p class="small muted" style="margin-top:2px">${r.detail}</p>`}
    <ul class="chain">${r.why.map((w) => html`<li>${w}</li>`)}</ul>
    <div class="next">
      <div><b>Next:</b> ${r.recommendation}
        ${r.sources?.length ? html`<div class="tiny muted" style="margin-top:4px">From: ${r.sources.map((s, i) => html`${i ? ', ' : ''}${sourceHref(s, r.project_id) ? html`<a href=${sourceHref(s, r.project_id)}>${s.label}</a>` : s.label}`)}</div>` : null}
      </div>
      <div class="act">
        ${r.actions.map((a) => html`<${Busy} class="btn sm primary" on=${busy === a.label} onClick=${() => run(a)}>${a.label}</${Busy}>`)}
        <button class="btn sm" onClick=${ask}>Ask Nelson OS</button>
        ${onDismiss && html`<button class="btn sm ghost" title="Hide for 7 days" onClick=${() => onDismiss(r.key)}>Hide</button>`}
      </div>
    </div>
  </article>`;
}

function WaitList({ items, empty, mine }) {
  if (!items.length) return html`<div class="items"><div class="empty">${empty}</div></div>`;
  const open = (w) => (w.type === 'threads' ? go(`#/inbox/${encodeURIComponent(w.id)}`) : w.project_id ? go(`#/projects/${w.project_id}/${TAB_FOR[w.type] || 'overview'}?open=${w.id}`) : null);
  return html`<div class="items">${items.slice(0, 8).map((w) => html`
    <button class="item" onClick=${() => open(w)}>
      <div class="grow"><div><span class="who">${w.who || 'Unknown'}</span> ${w.project && html`<span class="small muted">· ${w.project}</span>`}</div><div class="what">${w.what}</div>${w.hasReply ? html`<span class="chip ok" style="margin-top:4px">Reply ready</span>` : null}</div>
      <div class=${`age${w.overdue || (mine && w.age >= 3) ? ' late' : ''}`}>${w.due ? (w.overdue ? `due ${fmtDate(w.due)}` : until(w.due)) : ago(w.since)}</div>
    </button>`)}
    ${items.length > 8 ? html`<a class="item small muted" href="#/inbox">${items.length - 8} more</a>` : null}
  </div>`;
}

export function Today() {
  const { state } = useApp();
  const { data: b, error, reload } = useApi('/briefing');
  const [showAll, setShowAll] = useState(false);
  if (error) return html`<div class="page"><${ErrorNote} error=${error} /></div>`;
  if (!b) return html`<div class="page"><${Loading} /></div>`;
  const dismiss = async (key) => { await api('/risks/dismiss', { method: 'POST', body: { key, days: 7 } }); toast('Hidden for 7 days'); reload(); };
  const first = (state.profile.name || '').split(' ')[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const risks = showAll ? b.risks : b.attention;
  const noData = !b.projects.length && !state.microsoft.connected;

  return html`<div class="page">
    ${state.demo && html`<div class="banner info"><span class="chip">Sample data</span><span class="grow">You're looking at three sample projects. Connect Outlook to bring in your real ones; remove the samples anytime in Settings.</span></div>`}
    ${state.procore?.pendingApprovals > 0 && html`<div class="banner"><span class="grow"><b>${state.procore.pendingApprovals} Procore change${state.procore.pendingApprovals === 1 ? '' : 's'}</b> waiting for your approval. Nothing changes in Procore until you approve.</span><a class="btn sm primary" href="#/drafts">Review</a></div>`}
    ${state.sync.running && html`<div class="banner info"><span class="spinner"></span><span>Reading Outlook: ${state.sync.phase}${state.sync.total ? ` (${state.sync.done} of ${state.sync.total})` : ''}</span></div>`}
    <div class="titleblock" role="group" aria-label="Today at a glance">
      <div><div class="k">${greet}${first ? `, ${first}` : ''}</div><div class="v date">${fmtDate(b.date, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <a href="#/projects"><div class="k">Active projects</div><div class="v">${b.counts.projects}</div></a>
      <a href="#today-risks" class=${b.counts.high ? 'alert' : ''}><div class="k">High risks</div><div class="v">${b.counts.high}</div></a>
      <a href="#/inbox?ball=me"><div class="k">Waiting on you</div><div class="v">${b.counts.waitingOnMe}</div></a>
      <a href="#today-waiting"><div class="k">You're waiting on</div><div class="v">${b.counts.waitingOnOthers}</div></a>
    </div>

    ${noData ? html`<div class="panel empty" style="margin-top:24px"><b>Nothing here yet</b>Connect Outlook so Nelson OS can find your projects, or load sample projects to look around.<div class="row" style="justify-content:center;margin-top:14px"><a class="btn primary" href="#/connections">Connect Outlook</a><button class="btn" onClick=${() => api('/demo/load', { method: 'POST' }).then(() => location.reload()).catch(toastErr)}>Load sample projects</button></div></div>` : html`
    <div class="today">
      <section id="today-risks" aria-label="Needs attention">
        <div class="spread" style="margin-bottom:10px"><h2>Needs attention</h2>
          ${b.risks.length > b.attention.length && html`<button class="btn ghost sm" onClick=${() => setShowAll(!showAll)}>${showAll ? 'Show fewer' : `Show all ${b.risks.length}`}</button>`}</div>
        ${risks.length ? risks.map((r) => html`<${RiskCard} key=${r.key} r=${r} onDismiss=${dismiss} />`) : html`<div class="panel empty"><b>Nothing is at risk right now</b>Nelson OS checks RFIs, submittals, orders, schedule, permits and email every time it syncs.</div>`}
        ${b.counts.unconfirmed > 0 && html`<p class="small muted" style="margin-top:12px">${b.counts.unconfirmed} item${b.counts.unconfirmed === 1 ? '' : 's'} found in email still need your confirmation. They're marked "Found in email" in each project's logs.</p>`}
      </section>
      <aside>
        <div class="ball"><h2>Waiting on you <span class="n">${b.waitingOnMe.length}</span></h2><${WaitList} items=${b.waitingOnMe} empty="No one is waiting on you." mine=${true} /></div>
        <div class="ball" id="today-waiting"><h2>You're waiting on <span class="n">${b.waitingOnOthers.length}</span></h2><${WaitList} items=${b.waitingOnOthers} empty="Nothing outstanding." /></div>
        <${Changes} items=${b.changes || []} />
        <div class="ball"><h2>Next three weeks</h2>
          ${b.lookahead.length ? html`<div class="items">${b.lookahead.slice(0, 12).map((l) => html`<div class="look">
            <div class="d">${l.date < todayIso() ? 'Now' : fmtDate(l.date)}<span>${l.date < todayIso() ? `to ${fmtDate(l.end)}` : `${fmtDay(l.date)}${l.time ? ` ${l.time}` : ''}`}</span></div>
            <div><div style="font-weight:550">${l.title}</div><div class="small muted">${[l.project, l.who].filter(Boolean).join(' · ')}</div></div>
          </div>`)}</div>` : html`<div class="items"><div class="empty">No activities, deliveries or meetings in the next three weeks.</div></div>`}
        </div>
      </aside>
    </div>`}
  </div>`;
}
