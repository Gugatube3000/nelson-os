// Email triage: a fast rules pass (works with no AI), then an AI pass that understands each
// conversation, assigns it to a project, and pulls out RFIs, submittals, orders and dates.
import { db, get, getSetting, insert, list, logActivity, now, update } from '../db.js';
import { findAddress, findOrCreateProject, projectInText, resolveProject } from '../domain/projects.js';
import { complete, engineStatus } from '../ai/engine.js';
import { TRIAGE_SCHEMA, TRIAGE_SYSTEM, profile } from '../ai/prompts.js';
import { stripQuoted } from '../ai/tools.js';

const NON_WORK = /unsubscribe|newsletter|no-?reply@|noreply|do not reply|donotreply|webinar|% off|promo code|receipt for your|password reset|verify your email|security alert|linkedin|marketing@/i;
const CATEGORIES = [
  ['rfi', /\bRFI\b|request for information/i],
  ['submittal', /submittal|shop drawing|product data|cut sheets?|resubmit/i],
  ['change_order', /change order|\bP?CO\s?#?\s?\d|extra work|additional cost/i],
  ['permit_inspection', /permit|inspection|inspector|\bISD\b|building department|certificate of occupancy|dig safe/i],
  ['delivery', /deliver|shipment|tracking|\bETA\b|truck|lead time/i],
  ['invoice_payment', /invoice|payment|requisition|pay app|G70[23]|lien waiver|retainage/i],
  ['procurement', /quote|quotation|\bPO\b|purchase order|pricing|quantit|takeoff|take-off/i],
  ['schedule', /schedule|lookahead|look-ahead|delay|start date|mobiliz/i],
  ['owner_investor', /investor|lender|draw request|construction loan|capital call|distribution/i],
  ['design', /drawing|revision|architect|engineer|\bplans\b|sketch|\bASI\b|bulletin/i],
  ['bid_estimate', /\bbid\b|estimate|proposal|scope of work/i],
  ['safety', /safety|OSHA|incident|injury/i],
];
const REQUEST = /\?|please (?:confirm|advise|send|provide|approve|review|let me know|sign)|can you|could you|need (?:your|you to)|waiting (?:on|for) (?:your|you)|let me know|approval/i;
const URGENT = /urgent|asap|immediately|\btoday\b|tomorrow|end of day|\bEOD\b|overdue|stop work/i;

const myEmail = () => (getSetting('microsoft.account')?.email || profile().email || '').toLowerCase();
const isDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
const companyFromEmail = (email) => {
  const domain = String(email || '').split('@')[1] || '';
  if (!domain || /gmail|yahoo|outlook|hotmail|icloud|aol|comcast|verizon/i.test(domain)) return null;
  const base = domain.split('.').slice(-2, -1)[0] || '';
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
};

function threadEmails(threadId) {
  return db.prepare('SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at').all(threadId);
}

export function rulesTriage(thread, emails) {
  const last = emails[emails.length - 1];
  const body = stripQuoted(last?.body_text || '');
  const text = `${thread.subject}\n${body}`;
  const work = !NON_WORK.test(`${last?.from_email} ${thread.subject} ${(last?.body_text || '').slice(0, 3000)}`);
  const category = work ? (CATEGORIES.find(([, re]) => re.test(text))?.[0] || 'general') : 'not_work';
  const lastTo = JSON.parse(last?.to_json || '[]')[0];
  const ball = !work ? 'none' : last?.from_me ? 'them' : REQUEST.test(body) ? 'me' : 'none';
  const firstLine = body.split(/\n/).map((l) => l.trim()).find((l) => l.length > 20 && !/^(hi|hello|hey|good (morning|afternoon))\b/i.test(l)) || body.slice(0, 160);
  let project = null;
  if (work) {
    project = projectInText(text);
    const address = !project && findAddress(thread.subject);
    if (address) project = { name: address, address, is_new: true };
  }
  return {
    work_related: work,
    project: project ? { name: project.name, address: project.address || null, city: project.city || null, is_new: !!project.is_new } : null,
    category,
    summary: firstLine.slice(0, 220),
    ball,
    waiting_on: ball === 'them' ? lastTo?.name || lastTo?.email || null : ball === 'me' ? last?.from_name || last?.from_email : null,
    next_action: ball === 'me' ? `Reply to ${last?.from_name || 'sender'}` : ball === 'them' ? `Wait for ${lastTo?.name || 'a reply'}; follow up if nothing in a few days` : null,
    due_date: null,
    urgency: !work ? 0 : URGENT.test(text) ? 2 : ball === 'me' ? 1 : 0,
    suggested_reply: null,
    contacts: work ? emails.filter((e) => !e.from_me && e.from_email).map((e) => ({ name: e.from_name, email: e.from_email, company: companyFromEmail(e.from_email), role: 'other', trade: null })) : [],
    items: [],
  };
}

function mapStatus(type, s) {
  const v = String(s || '').toLowerCase();
  switch (type) {
    case 'rfi': return /answer|respon|clos/.test(v) ? 'answered' : /draft/.test(v) ? 'draft' : 'sent';
    case 'submittal': return /as noted/.test(v) ? 'approved_as_noted' : /approv/.test(v) ? 'approved' : /revise|resubmit/.test(v) ? 'revise_resubmit' : /reject/.test(v) ? 'rejected' : /submit|review/.test(v) ? 'submitted' : /receiv/.test(v) ? 'received' : 'requested';
    case 'order': return /install/.test(v) ? 'installed' : /deliver/.test(v) ? 'delivered' : /ship/.test(v) ? 'shipped' : /fabric/.test(v) ? 'in_fabrication' : /back.?order/.test(v) ? 'backordered' : /order|placed|\bpo\b|releas/.test(v) ? 'ordered' : /approv/.test(v) ? 'approved' : 'quote';
    case 'change_order': return /approv|execut|sign/.test(v) ? 'approved' : /reject|declin/.test(v) ? 'rejected' : /submit|pending|review/.test(v) ? 'pending' : 'potential';
    case 'permit': return /issued|approved/.test(v) ? 'issued' : /appl|submit|review/.test(v) ? 'applied' : /expir/.test(v) ? 'expired' : 'preparing';
    case 'inspection': return /pass/.test(v) ? 'passed' : /fail/.test(v) ? 'failed' : /partial/.test(v) ? 'partial' : /schedul|confirm|booked/.test(v) ? 'scheduled' : /request/.test(v) ? 'requested' : 'needed';
    default: return null;
  }
}

const TABLE_FOR = { rfi: 'rfis', submittal: 'submittals', order: 'orders', change_order: 'changes', permit: 'permits', inspection: 'inspections', schedule: 'schedule_items', takeoff_question: 'actions' };
const TITLE_COL = { rfis: 'subject', submittals: 'title', orders: 'item', changes: 'title', permits: 'kind', inspections: 'kind', schedule_items: 'name', actions: 'title' };
const simple = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function createDetected(item, thread, project, r) {
  const table = TABLE_FOR[item.type];
  if (!table || !item.title) return;
  const titleCol = TITLE_COL[table];
  const existing = db.prepare(`SELECT id, ${titleCol} t FROM ${table} WHERE project_id IS ? AND source = 'email'`).all(project?.id ?? null)
    .find((x) => simple(x.t) === simple(item.title));
  const supplier = r.contacts?.find((c) => c.role === 'supplier' || c.role === 'sub');
  const note = `From email "${thread.subject}"`;
  const fields = {
    rfis: { subject: item.title, question: item.details, drawing_refs: item.reference, date_required: isDate(item.date), status: mapStatus('rfi', item.status), thread_id: thread.id },
    submittals: { title: item.title, spec_section: item.reference, status: mapStatus('submittal', item.status), required_onsite: isDate(item.date), supplier: supplier?.company || supplier?.name || null, notes: item.details, thread_id: thread.id },
    orders: { item: item.title, quantity: item.quantity, unit: item.unit, need_by: isDate(item.date), status: mapStatus('order', item.status), supplier: supplier?.company || supplier?.name || null, supplier_email: supplier?.email || null, notes: item.details, thread_id: thread.id },
    changes: { title: item.title, description: item.details, amount: /\$|usd|dollar/i.test(item.unit || '') ? item.quantity : null, status: mapStatus('change_order', item.status), thread_id: thread.id },
    permits: { kind: item.title, number: item.reference, status: mapStatus('permit', item.status), notes: [item.details, note].filter(Boolean).join('\n') },
    inspections: { kind: item.title, scheduled_for: isDate(item.date), status: mapStatus('inspection', item.status), notes: [item.details, note].filter(Boolean).join('\n') },
    schedule_items: { name: item.title, start: isDate(item.date), notes: [item.details, note].filter(Boolean).join('\n') },
    actions: { title: item.title, detail: item.details, kind: 'takeoff', direction: 'on_me', thread_id: thread.id, counterparty: r.waiting_on },
  }[table];
  if (existing) {
    // Newer email about the same item: refresh its status and dates, keep what a person entered.
    const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v != null && ['status', 'date_required', 'required_onsite', 'need_by', 'scheduled_for', 'start', 'quantity'].includes(k)));
    if (Object.keys(patch).length) update(table, existing.id, patch);
    return;
  }
  const rec = insert(table, { ...fields, project_id: project?.id || null, source: 'email', review: 1, created_by: 'agent' });
  logActivity({
    kind: 'detected',
    project_id: project?.id || null,
    title: `Found ${item.type.replace('_', ' ')} "${item.title}" in email`,
    why: `Mentioned in "${thread.subject}". Marked unconfirmed until you review it.`,
    sources: [{ type: 'threads', id: thread.id, label: thread.subject }],
    entity_type: table,
    entity_id: rec.id,
  });
}

function upsertContact(c, projectId) {
  const email = String(c.email || '').toLowerCase();
  if (!email || email === myEmail() || NON_WORK.test(email)) return;
  const existing = db.prepare('SELECT * FROM contacts WHERE lower(email) = ?').get(email);
  if (existing) {
    const patch = {};
    for (const k of ['name', 'company', 'trade']) if (!existing[k] && c[k]) patch[k] = c[k];
    if ((!existing.role || existing.role === 'other') && c.role && c.role !== 'other') patch.role = c.role;
    if (!existing.project_id && projectId) patch.project_id = projectId;
    if (Object.keys(patch).length) update('contacts', existing.id, patch);
  } else {
    insert('contacts', { name: c.name, email, company: c.company, role: c.role || 'other', trade: c.trade, project_id: projectId, source: 'email', created_by: 'agent' });
  }
}

export function applyTriage(threadId, r, source) {
  const thread = get('threads', threadId);
  if (!thread) return;
  let project = null;
  if (r.work_related && r.project?.name) {
    project = resolveProject(r.project.name) || (r.project.address && resolveProject(r.project.address));
    if (!project && (r.project.is_new || source === 'ai')) {
      project = findOrCreateProject({ name: r.project.name, address: r.project.address, city: r.project.city, source: 'email', why: `Found in email "${thread.subject}".`, sources: [{ type: 'threads', id: thread.id, label: thread.subject }] });
    }
  }
  update('threads', threadId, {
    project_id: project?.id || thread.project_id || null,
    category: r.category,
    summary: r.summary,
    ball: r.ball,
    waiting_on: r.waiting_on,
    next_action: r.next_action,
    due_date: isDate(r.due_date),
    urgency: r.urgency ?? 0,
    suggested_reply: r.suggested_reply || (source === 'rules' ? thread.suggested_reply : null),
    work: r.work_related ? 1 : 0,
    triage_source: source,
    triaged_at: source === 'ai' ? now() : thread.triaged_at,
  });
  const pid = project?.id || thread.project_id || null;
  if (pid) {
    db.prepare('UPDATE emails SET project_id = ? WHERE thread_id = ?').run(pid, threadId);
    db.prepare("UPDATE search_fts SET project_id = ? WHERE kind = 'email' AND ref_id IN (SELECT id FROM emails WHERE thread_id = ?)").run(pid, threadId);
  }
  for (const c of r.contacts || []) upsertContact(c, pid);
  for (const item of r.items || []) createDetected(item, get('threads', threadId), project, r);
}

function threadForPrompt(t) {
  const emails = threadEmails(t.id).slice(-3);
  return {
    thread_id: t.id,
    subject: t.subject,
    messages: emails.map((e) => ({
      from: `${e.from_name || ''} <${e.from_email || ''}>${e.from_me ? ' (mailbox owner)' : ''}`,
      to: JSON.parse(e.to_json || '[]').map((a) => a.email).join(', '),
      date: e.received_at,
      attachments: JSON.parse(e.attachments_json || '[]').map((a) => a.name),
      body: stripQuoted(e.body_text).slice(0, 1800),
    })),
  };
}

async function aiTriageBatch(threads) {
  const projects = list('projects', {}, { order: 'name' }).slice(0, 80).map((p) => ({ name: p.name, address: p.address, city: p.city, aliases: p.aliases }));
  const prompt = `Mailbox owner: ${profile().name} <${myEmail()}>\nToday: ${new Date().toISOString().slice(0, 10)}\n\nExisting projects:\n${JSON.stringify(projects)}\n\nThreads:\n${JSON.stringify(threads.map(threadForPrompt))}`;
  const out = await complete({ system: TRIAGE_SYSTEM, prompt, schema: TRIAGE_SCHEMA, effort: 'low' });
  return out.threads || [];
}

/**
 * Triage every thread with new mail. Rules first (instant), then AI in batches.
 * progress(done, total) is called as batches finish.
 */
export async function triagePending({ progress, threadIds } = {}) {
  const rows = threadIds
    ? threadIds.map((id) => get('threads', id)).filter(Boolean)
    : db.prepare("SELECT * FROM threads WHERE triaged_at IS NULL OR last_at > triaged_at OR triage_source IS NULL OR triage_source = 'rules'").all();
  for (const t of rows) {
    if (t.triage_source !== 'ai' || threadIds) applyTriage(t.id, rulesTriage(t, threadEmails(t.id)), 'rules');
  }
  const { engine } = await engineStatus();
  if (engine === 'none') return { triaged: rows.length, ai: false };

  const queue = rows.map((t) => get('threads', t.id)).filter((t) => t.work);
  const size = engine === 'anthropic' ? 8 : 10;
  const batches = [];
  for (let i = 0; i < queue.length; i += size) batches.push(queue.slice(i, i + size));
  let done = 0;
  progress?.(0, queue.length);
  const parallel = engine === 'anthropic' ? 3 : 2;
  let failures = 0;
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      try {
        const results = await aiTriageBatch(batch);
        for (const r of results) if (batch.some((t) => t.id === r.thread_id)) applyTriage(r.thread_id, r, 'ai');
      } catch (err) {
        failures++;
        console.warn('[triage] batch failed:', err.message);
      }
      done += batch.length;
      progress?.(done, queue.length);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return { triaged: queue.length, ai: true, failures };
}

/** Write (or rewrite) a suggested reply for one thread. */
export async function suggestReply(threadId, instructions = '') {
  const t = get('threads', threadId);
  const me = profile();
  const text = await complete({
    system: `You write email replies for ${me.name}, ${me.title} at ${me.company}, a Greater Boston developer and builder. Direct, courteous, specific. Never promise quantities, prices or dates that are not in the thread or the provided facts; say what will be confirmed and when instead. No subject line. End with:\n${me.signature}`,
    prompt: `Thread:\n${JSON.stringify(threadForPrompt(t))}\n\n${instructions ? `Instructions: ${instructions}\n\n` : ''}Write the reply.`,
    effort: 'medium',
  });
  update('threads', threadId, { suggested_reply: text.trim() });
  return text.trim();
}
