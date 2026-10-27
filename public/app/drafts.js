import { html, useState, useEffect, api, useApi, go, toast, toastErr, ago, Drawer, Loading } from './lib.js';

const fmtAddr = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
const parseAddr = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = x.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  return m ? { name: m[1].trim() || null, email: m[2].trim() } : { name: null, email: x };
});

function DraftDrawer({ id, onClose, onChange }) {
  const { data: d, reload } = useApi(`/drafts/${id}`);
  const [f, setF] = useState(null);
  useEffect(() => { if (d) setF({ to: fmtAddr(d.to_json), cc: fmtAddr(d.cc_json), subject: d.subject || '', body: d.body || '' }); }, [d?.id]);
  if (!d || !f) return html`<${Drawer} title="Loading…" onClose=${onClose}><${Loading} /></${Drawer}>`;

  const save = () => api(`/drafts/${id}`, { method: 'PATCH', body: { to_json: parseAddr(f.to), cc_json: parseAddr(f.cc), subject: f.subject, body: f.body } });
  const openOutlook = async () => {
    try {
      await save();
      const a = document.createElement('a');
      a.href = `/api/drafts/${id}/eml`;
      a.download = '';
      a.click();
      toast('Downloaded. Open the file to get the email in Outlook, then press Send there.');
    } catch (e) { toastErr(e); }
  };
  const openWeb = async () => {
    await save();
    const fresh = await api(`/drafts/${id}`);
    window.open(fresh.links.outlookWeb, '_blank', 'noopener');
  };
  const copy = async () => { await navigator.clipboard.writeText(`${f.subject}\n\n${f.body}`); toast('Copied'); };
  const sent = async () => { await save(); await api(`/drafts/${id}/sent`, { method: 'POST' }); toast('Marked as sent. Logs updated.'); onChange(); onClose(); };
  const discard = async () => { await api(`/drafts/${id}`, { method: 'DELETE' }); toast('Draft discarded'); onChange(); onClose(); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const atts = d.attachments_json || [];

  return html`<${Drawer} title="Review and send" sub=${`${d.project || 'No project'} · ${d.created_by === 'agent' ? 'Written by Nelson OS' : 'Draft'}`} onClose=${onClose}
    foot=${html`<button class="btn ghost" onClick=${discard}>Discard</button><span class="grow"></span>
      <button class="btn" onClick=${sent} title="Use after you send it from Outlook">I sent it</button>
      <button class="btn primary" onClick=${openOutlook}>Open in Outlook</button>`}>
    <div class="stack">
      <label class="field">To<input class="input" value=${f.to} onInput=${set('to')} /></label>
      <label class="field">Cc<input class="input" value=${f.cc} onInput=${set('cc')} /></label>
      <label class="field">Subject<input class="input" value=${f.subject} onInput=${set('subject')} /></label>
      <label class="field">Message<textarea class="input" rows="14" value=${f.body} onInput=${set('body')}></textarea></label>
      ${atts.length ? html`<div><div class="small muted" style="margin-bottom:4px">Attached</div>${atts.map((a) => html`<a class="chip project" style="margin-right:6px" target="_blank" href=${a.type === 'rfi_pdf' ? `/api/rfis/${a.id}/pdf` : `/api/submittals/${a.id}/transmittal`}>${a.type === 'rfi_pdf' ? 'RFI form (PDF)' : 'Submittal transmittal (PDF)'}</a>`)}</div>` : null}
      <div class="panel" style="padding:12px 14px">
        <p class="small"><b>Open in Outlook</b> creates the email in Outlook${atts.length ? ' with the PDF attached' : ''}, ready for you to check and send.</p>
        <div class="row wrap" style="margin-top:8px"><button class="btn sm" onClick=${openWeb}>Use Outlook on the web instead</button><button class="btn sm" onClick=${copy}>Copy text</button></div>
        ${atts.length ? html`<p class="tiny muted" style="margin-top:6px">Outlook on the web can't receive attachments this way; download the PDF above and attach it.</p>` : null}
      </div>
    </div>
  </${Drawer}>`;
}

export function Drafts({ openId }) {
  const { data, loading, reload } = useApi('/drafts');
  return html`<div class="page">
    <div class="page-head"><div><h1>Drafts</h1><p class="muted">Replies, RFIs, transmittals and follow-ups ready for you to review and send from Outlook.</p></div></div>
    <div class="items">
      ${loading && !data ? html`<${Loading} />` : !data?.length ? html`<div class="empty"><b>No drafts waiting</b>Drafts appear here when you prepare an RFI or submittal, or when Nelson OS writes a reply for you.</div>` :
        data.map((d) => html`<button class="thread-row" onClick=${() => go(`#/drafts/${d.id}`)}>
          <div class="who">${(d.to_json || []).map((a) => a.name || a.email).join(', ') || 'No recipient'}</div>
          <div class="mid"><div class="row" style="gap:8px;flex-wrap:wrap"><span class="subj">${d.subject}</span>${d.project && html`<span class="chip project">${d.project}</span>`}${d.attachments_json?.length ? html`<span class="chip">PDF attached</span>` : null}${d.created_by === 'agent' ? html`<span class="chip ok">By Nelson OS</span>` : null}</div><div class="sum">${(d.body || '').slice(0, 160)}</div></div>
          <div class="small muted nowrap">${ago(d.created_at)}</div>
        </button>`)}
    </div>
    ${openId && html`<${DraftDrawer} id=${openId} onClose=${() => go('#/drafts')} onChange=${reload} />`}
  </div>`;
}
