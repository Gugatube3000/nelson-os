// Deterministic risk engine. Every risk explains its chain of facts ("why"),
// recommends one specific next action, and links the records it is built from.
import { getSetting, list, setSetting, today } from '../db.js';
import { budgetSummary } from './projects.js';

export const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
const fmt = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const GC_REVIEW_DAYS = 5;
const APPROVED = ['approved', 'approved_as_noted', 'closed'];
const OPEN_RFI = ['draft', 'sent'];
const ARRIVED = ['delivered', 'installed'];
const RELEASED = ['ordered', 'in_fabrication', 'shipped', 'delivered', 'installed'];

/** Date the submittal must reach the architect to support the on-site date. */
export function submitBy(s) {
  if (!s.required_onsite) return null;
  return addDays(s.required_onsite, -((s.lead_time_days || 0) + (s.review_days || 14) + GC_REVIEW_DAYS));
}
export function returnDue(s) {
  return s.date_submitted ? addDays(s.date_submitted, s.review_days || 14) : null;
}
export function releaseBy(o) {
  return o.need_by ? addDays(o.need_by, -(o.lead_time_days || 0)) : null;
}

const ORDER_STATE = { quote: 'still at quote (not ordered)', pending_approval: 'waiting for approval', approved: 'approved but not ordered', ordered: 'ordered', in_fabrication: 'in fabrication', shipped: 'shipped', backordered: 'backordered' };
const rfiLabel = (r) => `RFI-${String(r.number ?? '?').padStart(3, '0')}`;

export function computeRisks(projectId, { includeDismissed = false } = {}) {
  const t = today();
  const f = projectId ? { project_id: projectId } : {};
  const projects = Object.fromEntries(list('projects').map((p) => [p.id, p]));
  const rfis = list('rfis', f);
  const subs = list('submittals', f);
  const orders = list('orders', f);
  const sched = list('schedule_items', f);
  const permits = list('permits', f);
  const inspections = list('inspections', f);
  const takeoffs = list('takeoffs', f);
  const threads = list('threads', { ...f, status: 'open', work: 1 });
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const subById = byId(subs);
  const orderById = byId(orders);
  const rfiById = byId(rfis);
  const schedById = byId(sched);

  const risks = [];
  const add = (r) => risks.push({ severity: 'medium', sources: [], actions: [], ...r, why: [...new Set(r.why || [])], project: projects[r.project_id]?.name || null });

  // Downstream chain from a submittal: orders waiting on it and schedule activities that need it.
  const downstreamOfSubmittal = (s) => {
    const why = [];
    for (const o of orders.filter((o) => o.submittal_id === s.id && !RELEASED.includes(o.status))) {
      const rb = releaseBy(o);
      why.push(`${o.item}${o.quantity && !String(o.item).includes(String(o.quantity)) ? ` (${o.quantity} ${o.unit || ''})`.trimEnd() : ''} from ${o.supplier || 'the supplier'} can't be released for fabrication until this submittal is approved${rb ? `; with a ${o.lead_time_days || 0}-day lead time it must be released by ${fmt(rb)} to arrive by ${fmt(o.need_by)}` : ''}.`);
    }
    for (const a of sched.filter((a) => (a.submittal_ids || []).includes(s.id) && a.status !== 'complete')) {
      why.push(`Schedule activity "${a.name}" starts ${fmt(a.start)} and depends on it.`);
    }
    return why;
  };

  // 1. RFIs past their required-by date, with everything they hold up.
  for (const r of rfis) {
    if (r.status !== 'sent' || !r.date_required || r.date_required >= t) continue;
    const late = daysBetween(r.date_required, t);
    const why = [`${r.to_name || 'The design team'} owed an answer by ${fmt(r.date_required)} — ${late} day${late === 1 ? '' : 's'} overdue.`];
    const heldSubs = subs.filter((s) => s.rfi_id === r.id && !APPROVED.includes(s.status));
    for (const s of heldSubs) {
      why.push(`Submittal ${s.number || ''} ${s.title} is waiting on this answer (status: ${s.status.replaceAll('_', ' ')}).`);
      why.push(...downstreamOfSubmittal(s));
    }
    const heldActs = sched.filter((a) => (a.rfi_ids || []).includes(r.id) && a.status !== 'complete');
    for (const a of heldActs) why.push(`Schedule activity "${a.name}" starts ${fmt(a.start)} and depends on it.`);
    const blocking = heldSubs.length + heldActs.length;
    add({
      key: `rfi-overdue:${r.id}`,
      rule: 'rfi_overdue',
      severity: blocking ? 'high' : 'medium',
      project_id: r.project_id,
      title: `${rfiLabel(r)} is ${late} day${late === 1 ? '' : 's'} overdue${blocking ? ` and is holding up ${blocking} item${blocking === 1 ? '' : 's'}` : ''}`,
      detail: r.subject,
      why,
      recommendation: `Call ${r.to_name || 'the architect'} today, then send a written follow-up asking for a response by ${fmt(addDays(t, 2))}.${heldSubs.length ? ' Ask whether the submittal can be reviewed in parallel so fabrication is not held.' : ''}`,
      due: t,
      owner: 'You',
      sources: [{ type: 'rfis', id: r.id, label: `${rfiLabel(r)} ${r.subject || ''}` }, ...heldSubs.map((s) => ({ type: 'submittals', id: s.id, label: `Submittal ${s.number || ''} ${s.title}` }))],
      actions: [{ kind: 'followup', type: 'rfis', id: r.id, label: 'Draft follow-up' }],
    });
  }

  // 2. RFI drafts that never went out.
  for (const r of rfis) {
    if (r.status !== 'draft' || r.review) continue;
    const age = daysBetween((r.created_at || '').slice(0, 10) || t, t);
    if (age < 2) continue;
    add({
      key: `rfi-unsent:${r.id}`,
      rule: 'rfi_unsent',
      severity: 'low',
      project_id: r.project_id,
      title: `${rfiLabel(r)} has been a draft for ${age} days`,
      detail: r.subject,
      why: ['The question has not reached the design team, so their review clock has not started.'],
      recommendation: 'Review the draft and send it to the architect, or void it.',
      sources: [{ type: 'rfis', id: r.id, label: `${rfiLabel(r)} ${r.subject || ''}` }],
      actions: [{ kind: 'send', type: 'rfis', id: r.id, label: 'Open RFI' }],
    });
  }

  // 3. Submittals that must go to the architect now to protect the on-site date.
  for (const s of subs) {
    if (!['not_started', 'requested', 'received', 'gc_review'].includes(s.status)) continue;
    const sb = submitBy(s);
    if (!sb || daysBetween(t, sb) > 10) continue;
    const late = sb < t;
    const why = [`Needed on site ${fmt(s.required_onsite)}. Working back: ${s.lead_time_days || 0} days lead time + ${s.review_days || 14} days architect review + ${GC_REVIEW_DAYS} days our review → it must be submitted by ${fmt(sb)}.`,
      `Current status: ${s.status.replaceAll('_', ' ')}${s.supplier ? `, package from ${s.supplier}` : ''}.`];
    if (s.rfi_id && rfiById[s.rfi_id] && OPEN_RFI.includes(rfiById[s.rfi_id].status)) {
      why.push(`It also depends on ${rfiLabel(rfiById[s.rfi_id])}, which is still open.`);
    }
    why.push(...downstreamOfSubmittal(s));
    add({
      key: `sub-late:${s.id}`,
      rule: 'submittal_due',
      severity: late ? 'high' : 'medium',
      project_id: s.project_id,
      title: late ? `Submittal ${s.number || ''} ${s.title} is ${daysBetween(sb, t)} days late to the architect` : `Submittal ${s.number || ''} ${s.title} must go to the architect by ${fmt(sb)}`,
      why,
      recommendation: ['not_started', 'requested'].includes(s.status)
        ? `Get the package from ${s.supplier || 'the supplier'} by ${fmt(addDays(t, 2))}; if it is incomplete, submit what you have with a note on what follows.`
        : 'Finish GC review and transmit it to the architect today.',
      due: late ? t : sb,
      owner: ['not_started', 'requested'].includes(s.status) ? s.supplier || 'Supplier' : 'You',
      sources: [{ type: 'submittals', id: s.id, label: `Submittal ${s.number || ''} ${s.title}` }],
      actions: [{ kind: 'transmit', type: 'submittals', id: s.id, label: 'Prepare transmittal' }],
    });
  }

  // 4. Submittals sitting with the reviewer past the agreed review period, or sent back.
  for (const s of subs) {
    const rd = returnDue(s);
    if (s.status === 'submitted' && rd && rd < t) {
      add({
        key: `sub-review:${s.id}`,
        rule: 'submittal_review_late',
        severity: downstreamOfSubmittal(s).length ? 'high' : 'medium',
        project_id: s.project_id,
        title: `Submittal ${s.number || ''} ${s.title} is ${daysBetween(rd, t)} days past its review period`,
        why: [`Submitted ${fmt(s.date_submitted)} to ${s.reviewer_name || 'the architect'} with a ${s.review_days || 14}-day review; it was due back ${fmt(rd)}.`, ...downstreamOfSubmittal(s)],
        recommendation: `Ask ${s.reviewer_name || 'the architect'} for the review status and a return date.`,
        owner: s.reviewer_name || 'Architect',
        sources: [{ type: 'submittals', id: s.id, label: `Submittal ${s.number || ''} ${s.title}` }],
        actions: [{ kind: 'followup', type: 'submittals', id: s.id, label: 'Draft follow-up' }],
      });
    }
    if (['revise_resubmit', 'rejected'].includes(s.status)) {
      add({
        key: `sub-resubmit:${s.id}`,
        rule: 'submittal_resubmit',
        severity: 'high',
        project_id: s.project_id,
        title: `Submittal ${s.number || ''} ${s.title} came back "${s.status.replaceAll('_', ' ')}"`,
        why: ['Nothing can be ordered against it until a revised package is approved.', ...downstreamOfSubmittal(s)],
        recommendation: `Send the review comments to ${s.supplier || 'the supplier'} and get a resubmittal date.`,
        owner: s.supplier || 'Supplier',
        sources: [{ type: 'submittals', id: s.id, label: `Submittal ${s.number || ''} ${s.title}` }],
        actions: [],
      });
    }
  }

  // 5. Orders that must be released, and deliveries that land after they are needed.
  for (const o of orders) {
    if (ARRIVED.includes(o.status)) continue;
    const rb = releaseBy(o);
    if (!RELEASED.includes(o.status) && rb && daysBetween(t, rb) <= 7) {
      const sub = o.submittal_id ? subById[o.submittal_id] : null;
      const why = [`Need-by ${fmt(o.need_by)} with a ${o.lead_time_days || 0}-day lead time means the order must be released by ${fmt(rb)}.`];
      if (sub && !APPROVED.includes(sub.status)) why.push(`It is tied to submittal ${sub.number || ''} ${sub.title}, which is ${sub.status.replaceAll('_', ' ')}.`);
      if (o.takeoff_id) {
        const tk = takeoffs.find((x) => x.id === o.takeoff_id);
        if (tk?.unresolved) why.push(`The quantity still has open questions: ${tk.unresolved}`);
      }
      add({
        key: `order-release:${o.id}`,
        rule: 'order_release',
        severity: rb < t ? 'high' : 'medium',
        project_id: o.project_id,
        title: rb < t ? `${o.item} should have been released ${daysBetween(rb, t)} days ago` : `Release the ${o.item} order by ${fmt(rb)}`,
        why,
        recommendation: sub && !APPROVED.includes(sub.status)
          ? `Push the submittal approval first; ask ${o.supplier || 'the supplier'} if they can hold a production slot meanwhile.`
          : `Confirm quantities and release the PO to ${o.supplier || 'the supplier'}.`,
        owner: 'You',
        sources: [{ type: 'orders', id: o.id, label: o.item }, ...(sub ? [{ type: 'submittals', id: sub.id, label: `Submittal ${sub.number || ''} ${sub.title}` }] : [])],
        actions: [],
      });
    }
    if (o.need_by && ((o.expected_delivery && o.expected_delivery > o.need_by) || (!o.expected_delivery && o.need_by < t))) {
      const slip = o.expected_delivery ? daysBetween(o.need_by, o.expected_delivery) : daysBetween(o.need_by, t);
      const acts = sched.filter((a) => (a.order_ids || []).includes(o.id) && a.status !== 'complete');
      add({
        key: `order-late:${o.id}`,
        rule: 'delivery_late',
        severity: 'high',
        project_id: o.project_id,
        title: `${o.item} arrives ${slip} day${slip === 1 ? '' : 's'} after it is needed`,
        why: [`Needed ${fmt(o.need_by)}; ${o.expected_delivery ? `expected ${fmt(o.expected_delivery)}` : 'no confirmed delivery date'} from ${o.supplier || 'supplier'}.`,
          ...acts.map((a) => `"${a.name}" is scheduled to start ${fmt(a.start)}.`)],
        recommendation: 'Ask the supplier for a partial or expedited shipment, or resequence the work that depends on it.',
        owner: o.supplier || 'Supplier',
        sources: [{ type: 'orders', id: o.id, label: o.item }, ...acts.map((a) => ({ type: 'schedule_items', id: a.id, label: a.name }))],
        actions: [],
      });
    }
  }

  // 6. Upcoming activities whose prerequisites are not in place.
  for (const a of sched) {
    if (a.status === 'complete' || !a.start) continue;
    const until = daysBetween(t, a.start);
    if (until > 21) continue;
    const blockers = [];
    for (const id of a.submittal_ids || []) {
      const s = subById[id];
      if (s && !APPROVED.includes(s.status)) blockers.push(`Submittal ${s.number || ''} ${s.title} is not approved yet (${s.status.replaceAll('_', ' ')}).`);
    }
    for (const id of a.order_ids || []) {
      const o = orderById[id];
      if (o && !ARRIVED.includes(o.status) && (!o.expected_delivery || o.expected_delivery > a.start)) {
        blockers.push(`${o.item} is ${ORDER_STATE[o.status] || o.status.replaceAll('_', ' ')}${o.expected_delivery ? `, expected ${fmt(o.expected_delivery)}` : ', with no delivery date'}.`);
      }
    }
    for (const id of a.rfi_ids || []) {
      const r = rfiById[id];
      if (r && OPEN_RFI.includes(r.status)) blockers.push(`${rfiLabel(r)} "${r.subject}" is unanswered.`);
    }
    for (const id of a.predecessor_ids || []) {
      const p = schedById[id];
      if (p && p.status !== 'complete' && p.finish && p.finish > a.start) blockers.push(`Predecessor "${p.name}" finishes ${fmt(p.finish)}, after this start.`);
    }
    if (!blockers.length && !(a.finish && a.finish < t && until < 0)) continue;
    if (blockers.length) {
      add({
        key: `sched-blocked:${a.id}`,
        rule: 'activity_blocked',
        severity: until <= 7 ? 'high' : 'medium',
        project_id: a.project_id,
        title: until >= 0 ? `"${a.name}" starts in ${until} day${until === 1 ? '' : 's'} with ${blockers.length} open prerequisite${blockers.length === 1 ? '' : 's'}` : `"${a.name}" should have started ${-until} days ago`,
        why: blockers,
        recommendation: until <= 7 ? 'Clear the first prerequisite today or warn the trade and resequence the lookahead.' : 'Clear these before the next lookahead meeting.',
        owner: a.responsible || 'You',
        due: a.start,
        sources: [{ type: 'schedule_items', id: a.id, label: a.name }],
        actions: [],
      });
    }
  }
  for (const a of sched) {
    if (a.status === 'complete' || !a.finish || a.finish >= t) continue;
    add({
      key: `sched-late:${a.id}`,
      rule: 'activity_late',
      severity: 'medium',
      project_id: a.project_id,
      title: `"${a.name}" was due to finish ${fmt(a.finish)} (${a.percent || 0}% done)`,
      why: [`${daysBetween(a.finish, t)} days past its finish date.`, ...sched.filter((x) => (x.predecessor_ids || []).includes(a.id)).map((x) => `"${x.name}" (starts ${fmt(x.start)}) follows it.`)],
      recommendation: `Get a new finish date from ${a.responsible || 'the trade'} and update the schedule.`,
      owner: a.responsible || 'Trade',
      sources: [{ type: 'schedule_items', id: a.id, label: a.name }],
      actions: [],
    });
  }

  // 7. Permits and inspections.
  for (const p of permits) {
    if (p.status === 'issued' && p.expires_on && daysBetween(t, p.expires_on) <= 30) {
      add({
        key: `permit-exp:${p.id}`,
        rule: 'permit_expiring',
        severity: daysBetween(t, p.expires_on) <= 7 ? 'high' : 'medium',
        project_id: p.project_id,
        title: `${p.kind || 'Permit'} ${p.number || ''} expires ${fmt(p.expires_on)}`,
        why: [`Issued by ${p.jurisdiction || 'the city'}${p.issued_on ? ` on ${fmt(p.issued_on)}` : ''}.`, 'In Boston, work must start within six months of issuance; some permits can be extended 180 days.'],
        recommendation: 'Confirm work has started and request an extension if needed.',
        sources: [{ type: 'permits', id: p.id, label: `${p.kind || 'Permit'} ${p.number || ''}` }],
        actions: [],
      });
    }
    if (p.status === 'applied' && p.applied_on && daysBetween(p.applied_on, t) >= 21) {
      add({
        key: `permit-wait:${p.id}`,
        rule: 'permit_pending',
        severity: 'low',
        project_id: p.project_id,
        title: `${p.kind || 'Permit'} application pending ${daysBetween(p.applied_on, t)} days`,
        why: [`Applied ${fmt(p.applied_on)} with ${p.jurisdiction || 'the city'}.`],
        recommendation: 'Check the portal for reviewer comments or missing documents.',
        sources: [{ type: 'permits', id: p.id, label: `${p.kind || 'Permit'} ${p.number || ''}` }],
        actions: [],
      });
    }
  }
  for (const i of inspections) {
    if (!['needed', 'requested'].includes(i.status)) continue;
    const act = i.schedule_item_id ? schedById[i.schedule_item_id] : null;
    const when = i.scheduled_for || act?.start;
    if (!when || daysBetween(t, when) > 7) continue;
    add({
      key: `insp:${i.id}`,
      rule: 'inspection_needed',
      severity: 'medium',
      project_id: i.project_id,
      title: `${i.kind || 'Inspection'} needs to be ${i.status === 'needed' ? 'requested' : 'confirmed'} before ${fmt(when)}`,
      why: [act ? `"${act.name}" can't be covered up until it passes.` : 'Work cannot proceed past this point until it passes.'],
      recommendation: i.status === 'needed' ? 'Request the inspection through the city portal or by phone.' : 'Confirm the inspection slot with the inspector.',
      sources: [{ type: 'inspections', id: i.id, label: i.kind || 'Inspection' }],
      actions: [],
    });
  }

  // 8. Email: replies owed and follow-ups.
  for (const th of threads) {
    const age = daysBetween((th.last_at || '').slice(0, 10) || t, t);
    if (th.ball === 'me' && (age >= 2 || th.urgency >= 3)) {
      add({
        key: `reply:${th.id}`,
        rule: 'reply_owed',
        severity: th.urgency >= 3 ? 'high' : age >= 4 || th.urgency >= 2 ? 'medium' : 'low',
        project_id: th.project_id,
        title: `${th.waiting_on || 'Someone'} has been waiting ${age} day${age === 1 ? '' : 's'} for your reply`,
        detail: th.subject,
        why: [th.summary || th.subject].filter(Boolean),
        recommendation: th.next_action || 'Reply or delegate.',
        owner: 'You',
        sources: [{ type: 'threads', id: th.id, label: th.subject }],
        actions: [{ kind: 'reply', type: 'threads', id: th.id, label: th.suggested_reply ? 'Review suggested reply' : 'Open thread' }],
      });
    }
    if (th.ball === 'them' && age >= 5) {
      add({
        key: `followup:${th.id}`,
        rule: 'followup',
        severity: 'low',
        project_id: th.project_id,
        title: `No answer from ${th.waiting_on || 'them'} in ${age} days`,
        detail: th.subject,
        why: [th.summary || th.subject].filter(Boolean),
        recommendation: 'Send a short follow-up.',
        owner: th.waiting_on || 'Them',
        sources: [{ type: 'threads', id: th.id, label: th.subject }],
        actions: [{ kind: 'reply', type: 'threads', id: th.id, label: 'Open thread' }],
      });
    }
  }

  // 9. Cost exposure.
  for (const p of Object.values(projects)) {
    if (projectId && p.id !== projectId) continue;
    const b = budgetSummary(p.id);
    if (b.contingencyRemaining != null && b.pendingChanges > 0 && b.pendingChanges > b.contingencyRemaining) {
      add({
        key: `cost-contingency:${p.id}`,
        rule: 'contingency',
        severity: 'high',
        project_id: p.id,
        title: `Pending changes (${money(b.pendingChanges)}) exceed remaining contingency (${money(b.contingencyRemaining)})`,
        why: [`Contingency ${money(b.contingency)}, approved changes ${money(b.approvedChanges)}.`],
        recommendation: 'Review pending change orders with the owner/investors before approving more scope.',
        sources: [{ type: 'projects', id: p.id, label: p.name }],
        actions: [],
      });
    }
    if (b.budget && b.committed > b.budget) {
      add({
        key: `cost-budget:${p.id}`,
        rule: 'over_budget',
        severity: 'high',
        project_id: p.id,
        title: `Committed cost ${money(b.committed)} is over the ${money(b.budget)} budget`,
        why: ['Committed = all orders past the quote stage.'],
        recommendation: 'Reforecast the budget and identify value-engineering options.',
        sources: [{ type: 'projects', id: p.id, label: p.name }],
        actions: [],
      });
    }
  }

  const dismissed = getSetting('risks.dismissed', {}) || {};
  const rank = { high: 0, medium: 1, low: 2 };
  return risks
    .map((r) => ({ ...r, dismissed: dismissed[r.key] && dismissed[r.key] >= t }))
    .filter((r) => includeDismissed || !r.dismissed)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || String(a.due || '9999').localeCompare(String(b.due || '9999')));
}

export function dismissRisk(key, days = 7) {
  const dismissed = getSetting('risks.dismissed', {}) || {};
  dismissed[key] = addDays(today(), days);
  setSetting('risks.dismissed', dismissed);
}
