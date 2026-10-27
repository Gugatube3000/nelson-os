import { html, useState, useEffect, api, useApi, go, toast, toastErr, fmtDate, fmtMoney, todayIso, label, rfiNo, Drawer, Busy, Loading } from './lib.js';

const opt = (...xs) => xs.map((x) => [x, label(x)]);
const STATUS = {
  rfis: opt('draft', 'sent', 'answered', 'closed', 'void'),
  submittals: opt('not_started', 'requested', 'received', 'gc_review', 'submitted', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected', 'closed'),
  orders: opt('quote', 'pending_approval', 'approved', 'ordered', 'in_fabrication', 'shipped', 'delivered', 'installed', 'backordered'),
  takeoffs: opt('draft', 'reviewed'),
  schedule_items: opt('not_started', 'in_progress', 'complete', 'delayed'),
  changes: opt('potential', 'pending', 'approved', 'rejected', 'void'),
  permits: opt('preparing', 'applied', 'issued', 'expired', 'closed'),
  inspections: opt('needed', 'requested', 'scheduled', 'passed', 'failed', 'partial'),
};
const IMPACT = opt('tbd', 'none', 'yes');
const DONE = { rfis: ['answered', 'closed', 'void'], submittals: ['approved', 'approved_as_noted', 'closed'], orders: ['delivered', 'installed'], schedule_items: ['complete'], changes: ['approved', 'rejected', 'void'], permits: ['closed', 'expired'], inspections: ['passed'] };
const late = (d, open = true) => open && d && d < todayIso();

const statusChip = (entity, s) => {
  const good = ['answered', 'approved', 'approved_as_noted', 'delivered', 'installed', 'complete', 'issued', 'passed', 'reviewed', 'closed'];
  const bad = ['revise_resubmit', 'rejected', 'failed', 'expired', 'backordered', 'delayed'];
  return html`<span class=${`chip${good.includes(s) ? ' ok' : bad.includes(s) ? ' high' : ''}`}>${label(s)}</span>`;
};

// Field types: t text, ta textarea, d date, n number, s select, ref single record, refs multiple records.
export const LOGS = {
  rfis: {
    title: 'RFIs', one: 'RFI',
    cols: [['No.', (r) => rfiNo(r.number)], ['Subject', (r) => r.subject], ['To', (r) => r.to_name], ['Sent', (r) => fmtDate(r.date_sent)],
      ['Due', (r) => fmtDate(r.date_required), (r) => late(r.date_required, r.status === 'sent')], ['Status', (r) => statusChip('rfis', r.status)]],
    fields: [['subject', 'Subject', 't'], ['question', 'Question', 'ta'], ['proposed_solution', 'Proposed solution', 'ta'], ['drawing_refs', 'Drawing references', 't'], ['spec_refs', 'Spec sections', 't'],
      ['to_name', 'To (architect or engineer)', 't'], ['to_email', 'Their email', 't'], ['date_required', 'Response needed by', 'd'], ['status', 'Status', 's', STATUS.rfis],
      ['cost_impact', 'Cost impact', 's', IMPACT], ['schedule_impact', 'Schedule impact', 's', IMPACT], ['date_sent', 'Date sent', 'd'], ['answer', 'Answer', 'ta'], ['date_answered', 'Date answered', 'd']],
    title_of: (r) => `${rfiNo(r.number)} ${r.subject || ''}`,
  },
  submittals: {
    title: 'Submittals', one: 'Submittal',
    cols: [['No.', (r) => r.number], ['Item', (r) => r.title], ['Supplier', (r) => r.supplier], ['Status', (r) => statusChip('submittals', r.status)],
      ['Submit by', (r) => fmtDate(r.submit_by), (r) => late(r.submit_by, ['not_started', 'requested', 'received', 'gc_review'].includes(r.status))],
      ['Back by', (r) => fmtDate(r.return_due), (r) => late(r.return_due, r.status === 'submitted')], ['On site', (r) => fmtDate(r.required_onsite)]],
    fields: [['title', 'Item', 't'], ['number', 'Submittal number', 't'], ['spec_section', 'Spec section', 't'], ['kind', 'Type', 's', opt('shop drawings', 'product data', 'samples', 'mockup', 'certificates', 'O&M', 'warranty')],
      ['supplier', 'Sub or supplier', 't'], ['reviewer_name', 'Reviewer', 't'], ['reviewer_email', 'Reviewer email', 't'], ['status', 'Status', 's', STATUS.submittals],
      ['required_onsite', 'Needed on site', 'd'], ['lead_time_days', 'Lead time after approval (days)', 'n'], ['review_days', 'Review period (days)', 'n'],
      ['date_submitted', 'Date submitted', 'd'], ['date_returned', 'Date returned', 'd'], ['rfi_id', 'Waiting on RFI', 'ref', 'rfis'], ['notes', 'Notes', 'ta']],
    title_of: (r) => `${r.number || ''} ${r.title || ''}`,
  },
  orders: {
    title: 'Orders and deliveries', one: 'Order',
    cols: [['Item', (r) => r.item], ['Qty', (r) => (r.quantity != null ? `${r.quantity} ${r.unit || ''}` : '—')], ['Supplier', (r) => r.supplier], ['Status', (r) => statusChip('orders', r.status)],
      ['Release by', (r) => fmtDate(r.release_by), (r) => late(r.release_by, ['quote', 'pending_approval', 'approved'].includes(r.status))],
      ['Need by', (r) => fmtDate(r.need_by)], ['Expected', (r) => fmtDate(r.expected_delivery), (r) => r.expected_delivery && r.need_by && r.expected_delivery > r.need_by], ['Cost', (r) => fmtMoney(r.cost)]],
    fields: [['item', 'Item', 't'], ['quantity', 'Quantity', 'n'], ['unit', 'Unit', 't'], ['spec_section', 'Spec section', 't'], ['supplier', 'Supplier', 't'], ['supplier_email', 'Supplier email', 't'],
      ['po_number', 'PO number', 't'], ['status', 'Status', 's', STATUS.orders], ['lead_time_days', 'Lead time (days)', 'n'], ['need_by', 'Needed on site', 'd'],
      ['expected_delivery', 'Expected delivery', 'd'], ['delivered_on', 'Delivered on', 'd'], ['cost', 'Cost ($)', 'n'], ['submittal_id', 'Submittal', 'ref', 'submittals'], ['takeoff_id', 'Takeoff line', 'ref', 'takeoffs'], ['notes', 'Notes', 'ta']],
    title_of: (r) => r.item,
  },
  takeoffs: {
    title: 'Takeoffs', one: 'Takeoff line',
    cols: [['Item', (r) => r.item], ['Qty', (r) => (r.quantity != null ? `${r.quantity} ${r.unit || ''}` : '—')], ['Where', (r) => r.location], ['Status', (r) => statusChip('takeoffs', r.status)], ['Open questions', (r) => r.unresolved || '—', (r) => !!r.unresolved]],
    fields: [['item', 'Item', 't'], ['quantity', 'Quantity', 'n'], ['unit', 'Unit', 't'], ['location', 'Location', 't'], ['spec_section', 'Spec section', 't'], ['status', 'Status', 's', STATUS.takeoffs], ['unresolved', 'Open questions (unresolved dimensions, conflicts)', 'ta'], ['notes', 'Notes', 'ta']],
    title_of: (r) => r.item,
  },
  schedule_items: {
    title: 'Schedule', one: 'Activity',
    cols: [['Activity', (r) => r.name], ['Trade', (r) => r.trade], ['Start', (r) => fmtDate(r.start)], ['Finish', (r) => fmtDate(r.finish), (r) => late(r.finish, r.status !== 'complete')], ['Status', (r) => statusChip('schedule_items', r.status)], ['%', (r) => `${r.percent || 0}%`], ['Responsible', (r) => r.responsible]],
    fields: [['name', 'Activity', 't'], ['trade', 'Trade', 't'], ['responsible', 'Responsible', 't'], ['start', 'Start', 'd'], ['finish', 'Finish', 'd'], ['status', 'Status', 's', STATUS.schedule_items], ['percent', 'Percent complete', 'n'],
      ['predecessor_ids', 'Comes after', 'refs', 'schedule_items'], ['submittal_ids', 'Needs approved submittals', 'refs', 'submittals'], ['order_ids', 'Needs delivered material', 'refs', 'orders'], ['rfi_ids', 'Needs RFI answers', 'refs', 'rfis'], ['notes', 'Notes', 'ta']],
    title_of: (r) => r.name,
  },
  changes: {
    title: 'Change orders', one: 'Change order',
    cols: [['No.', (r) => `CO-${r.number}`], ['Title', (r) => r.title], ['Amount', (r) => fmtMoney(r.amount)], ['Status', (r) => statusChip('changes', r.status)], ['Reason', (r) => label(r.reason)]],
    fields: [['title', 'Title', 't'], ['description', 'Description', 'ta'], ['amount', 'Amount ($)', 'n'], ['status', 'Status', 's', STATUS.changes], ['reason', 'Reason', 's', opt('owner', 'design', 'field', 'allowance', 'unforeseen')], ['date_submitted', 'Submitted', 'd'], ['date_approved', 'Approved', 'd'], ['rfi_id', 'From RFI', 'ref', 'rfis']],
    title_of: (r) => `CO-${r.number} ${r.title || ''}`,
  },
  permits: {
    title: 'Permits', one: 'Permit',
    cols: [['Permit', (r) => r.kind], ['Number', (r) => r.number], ['Jurisdiction', (r) => r.jurisdiction], ['Status', (r) => statusChip('permits', r.status)], ['Applied', (r) => fmtDate(r.applied_on)], ['Issued', (r) => fmtDate(r.issued_on)], ['Expires', (r) => fmtDate(r.expires_on)]],
    fields: [['kind', 'Permit', 't'], ['number', 'Number', 't'], ['jurisdiction', 'Jurisdiction', 't'], ['status', 'Status', 's', STATUS.permits], ['applied_on', 'Applied', 'd'], ['issued_on', 'Issued', 'd'], ['expires_on', 'Expires', 'd'], ['notes', 'Notes', 'ta']],
    title_of: (r) => `${r.kind || ''} ${r.number || ''}`,
  },
  inspections: {
    title: 'Inspections', one: 'Inspection',
    cols: [['Inspection', (r) => r.kind], ['Date', (r) => fmtDate(r.scheduled_for)], ['Status', (r) => statusChip('inspections', r.status)], ['Inspector', (r) => r.inspector]],
    fields: [['kind', 'Inspection', 't'], ['scheduled_for', 'Date', 'd'], ['status', 'Status', 's', STATUS.inspections], ['inspector', 'Inspector', 't'], ['permit_id', 'Permit', 'ref', 'permits'], ['schedule_item_id', 'Before activity', 'ref', 'schedule_items'], ['notes', 'Notes', 'ta']],
    title_of: (r) => r.kind,
  },
  contacts: {
    title: 'Contacts', one: 'Contact',
    cols: [['Name', (r) => r.name], ['Company', (r) => r.company], ['Role', (r) => label(r.role)], ['Trade', (r) => r.trade], ['Email', (r) => r.email], ['Phone', (r) => r.phone]],
    fields: [['name', 'Name', 't'], ['company', 'Company', 't'], ['role', 'Role', 's', opt('architect', 'engineer', 'sub', 'supplier', 'owner', 'investor', 'lender', 'inspector', 'city', 'consultant', 'internal', 'other')], ['trade', 'Trade', 't'], ['email', 'Email', 't'], ['phone', 'Phone', 't'], ['notes', 'Notes', 'ta']],
    title_of: (r) => r.name,
  },
  projects: {
    title: 'Projects', one: 'Project',
    cols: [],
    fields: [['name', 'Name', 't'], ['address', 'Street address', 't'], ['city', 'City', 't'], ['type', 'Type', 't'], ['phase', 'Phase', 't'], ['status', 'Status', 's', opt('active', 'on_hold', 'closed')], ['client', 'Owner / client', 't'],
      ['start_date', 'Start', 'd'], ['target_completion', 'Target completion', 'd'], ['contract_value', 'Contract value ($)', 'n'], ['budget', 'Budget ($)', 'n'], ['contingency', 'Contingency ($)', 'n']],
    title_of: (r) => r.name,
  },
};

function RefOptions({ entity, projectId, value, multi, onChange }) {
  const { data } = useApi(`/records/${entity}?project_id=${projectId}`);
  const items = data || [];
  const name = (r) => LOGS[entity]?.title_of(r) || r.id;
  if (!multi) {
    return html`<select class="input" value=${value || ''} onChange=${(e) => onChange(e.target.value || null)}><option value="">None</option>${items.map((r) => html`<option value=${r.id}>${name(r)}</option>`)}</select>`;
  }
  const set = new Set(value || []);
  return html`<div class="items" style="max-height:150px;overflow:auto">${items.length ? items.map((r) => html`<label class="row small" style="padding:6px 10px;cursor:pointer">
    <input type="checkbox" checked=${set.has(r.id)} onChange=${(e) => { const n = new Set(set); if (e.target.checked) n.add(r.id); else n.delete(r.id); onChange([...n]); }} />${name(r)}</label>`) : html`<div class="small muted" style="padding:8px 10px">None yet</div>`}</div>`;
}

export function RecordDrawer({ entity, id, projectId, initial, onClose, onSaved }) {
  const cfg = LOGS[entity];
  const isNew = !id;
  const { data: loaded } = useApi(isNew ? null : `/records/${entity}/${id}`);
  const [f, setF] = useState(isNew ? { ...(initial || {}) } : null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { if (loaded) setF(loaded); }, [loaded]);
  if (!f) return html`<${Drawer} title="Loading…" onClose=${onClose}><${Loading} /></${Drawer}>`;
  const set = (k, v) => setF({ ...f, [k]: v });

  const save = async () => {
    setBusy('save');
    try {
      const body = {};
      for (const [k, , type] of cfg.fields) body[k] = type === 'n' ? (f[k] === '' || f[k] == null ? null : Number(f[k])) : f[k] ?? null;
      if (projectId && entity !== 'projects') body.project_id = projectId;
      const rec = isNew ? await api(`/records/${entity}`, { method: 'POST', body }) : await api(`/records/${entity}/${id}`, { method: 'PATCH', body });
      toast(`${cfg.one} saved`);
      onSaved?.(rec);
      onClose();
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const confirm = async () => { await api(`/records/${entity}/${id}/confirm`, { method: 'POST' }); toast('Confirmed'); onSaved?.(); onClose(); };
  const del = async () => { if (!window.confirm(`Remove this ${cfg.one.toLowerCase()}?`)) return; await api(`/records/${entity}/${id}`, { method: 'DELETE' }); toast('Removed'); onSaved?.(); onClose(); };
  const draft = async (path) => { setBusy(path); try { const d = await api(path, { method: 'POST', body: { type: entity, id } }); go(`#/drafts/${d.id}`); } catch (e) { toastErr(e); } finally { setBusy(null); } };

  const extra = !isNew && entity === 'rfis' ? html`
    <a class="btn" href=${`/api/rfis/${id}/pdf`} target="_blank">RFI form (PDF)</a>
    <${Busy} class="btn" on=${busy === `/rfis/${id}/prepare`} onClick=${() => draft(`/rfis/${id}/prepare`)}>Prepare email to ${f.to_name?.split(' ')[0] || 'architect'}</${Busy}>
    ${f.status === 'sent' && html`<${Busy} class="btn" on=${busy === '/followup'} onClick=${() => draft('/followup')}>Follow up</${Busy}>`}`
    : !isNew && entity === 'submittals' ? html`
    <a class="btn" href=${`/api/submittals/${id}/transmittal`} target="_blank">Transmittal (PDF)</a>
    <${Busy} class="btn" on=${busy === `/submittals/${id}/prepare`} onClick=${() => draft(`/submittals/${id}/prepare`)}>Prepare email to reviewer</${Busy}>
    ${f.status === 'submitted' && html`<${Busy} class="btn" on=${busy === '/followup'} onClick=${() => draft('/followup')}>Follow up</${Busy}>`}` : null;

  return html`<${Drawer} title=${isNew ? `New ${cfg.one.toLowerCase()}` : cfg.title_of(f)} sub=${!isNew && f.created_by === 'agent' ? 'Added by Nelson OS' : null} onClose=${onClose}
    foot=${html`${!isNew && html`<button class="btn ghost" onClick=${del}>Remove</button>`}<span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><${Busy} class="btn primary" on=${busy === 'save'} onClick=${save}>Save</${Busy}>`}>
    ${f.review ? html`<div class="banner"><span class="chip review">Found in email</span><span class="grow">Nelson OS found this in email. Check it, then confirm it.</span><button class="btn sm primary" onClick=${confirm}>Confirm</button></div>` : null}
    ${extra && html`<div class="row wrap" style="margin-bottom:16px">${extra}</div>`}
    ${f.thread_id && html`<p class="small" style="margin-bottom:12px"><a href=${`#/inbox/${encodeURIComponent(f.thread_id)}`}>Open the email this came from</a></p>`}
    <div class="stack">
      ${cfg.fields.map(([k, lbl, type, o]) => html`<label class="field">${lbl}
        ${type === 'ta' ? html`<textarea class="input" rows="4" value=${f[k] ?? ''} onInput=${(e) => set(k, e.target.value)}></textarea>`
          : type === 's' ? html`<select class="input" value=${f[k] ?? ''} onChange=${(e) => set(k, e.target.value)}><option value="">—</option>${o.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`
          : type === 'ref' ? html`<${RefOptions} entity=${o} projectId=${projectId || f.project_id} value=${f[k]} onChange=${(v) => set(k, v)} />`
          : type === 'refs' ? html`<${RefOptions} entity=${o} projectId=${projectId || f.project_id} value=${f[k]} multi onChange=${(v) => set(k, v)} />`
          : html`<input class="input" type=${type === 'd' ? 'date' : type === 'n' ? 'number' : 'text'} step=${type === 'n' ? 'any' : undefined} value=${f[k] ?? ''} onInput=${(e) => set(k, e.target.value)} />`}
      </label>`)}
    </div>
  </${Drawer}>`;
}

export function LogTable({ entity, projectId, openId, onChanged, compact }) {
  const cfg = LOGS[entity];
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState(openId ? { id: openId } : null);
  const { data, loading, reload } = useApi(`/records/${entity}?project_id=${projectId}`);
  useEffect(() => { if (openId) setOpen({ id: openId }); }, [openId]);
  const done = DONE[entity] || [];
  const rows = (data || []).filter((r) => showDone || !done.includes(r.status));
  const hidden = (data || []).length - rows.length;
  const changed = () => { reload(); onChanged?.(); };
  return html`<section style="margin-bottom:24px">
    <div class="spread" style="margin-bottom:10px">
      <h2>${cfg.title} <span class="muted small" style="font-weight:500">${rows.length}</span></h2>
      <div class="row">${hidden > 0 || showDone ? html`<button class="btn ghost sm" onClick=${() => setShowDone(!showDone)}>${showDone ? 'Hide closed' : `Show ${hidden} closed`}</button>` : null}
        <button class="btn sm" onClick=${() => setOpen({ id: null })}>Add ${cfg.one.toLowerCase()}</button></div>
    </div>
    ${loading && !data ? html`<${Loading} />` : rows.length ? html`<div class="table-wrap"><table class="log cardify">
      <thead><tr>${cfg.cols.map(([h]) => html`<th>${h}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr onClick=${() => setOpen({ id: r.id })}>${cfg.cols.map(([h, fn, isLate], i) => html`<td data-label=${h} class=${isLate?.(r) ? 'late' : ''}>${fn(r) ?? '—'}${i === 1 && r.review ? html` <span class="chip review">Found in email</span>` : null}${i === 1 && r.created_by === 'agent' && !r.review ? html` <span class="chip">By Nelson OS</span>` : null}</td>`)}</tr>`)}</tbody>
    </table></div>` : html`<div class="items"><div class="empty">${compact ? 'None yet.' : html`<b>No ${cfg.title.toLowerCase()} yet</b>Add one, or ask Nelson OS to create it from an email or drawing.`}</div></div>`}
    ${open && html`<${RecordDrawer} entity=${entity} id=${open.id} projectId=${projectId} onClose=${() => setOpen(null)} onSaved=${changed} />`}
  </section>`;
}
