import { getSetting } from '../db.js';
import { CONFIG } from '../paths.js';

export function profile() {
  const p = getSetting('profile', {}) || {};
  return {
    name: p.name || 'Jonathan',
    title: p.title || 'Project Manager',
    company: p.company || CONFIG.company || 'Nelson Group',
    email: p.email || getSetting('microsoft.account', {})?.email || '',
    phone: p.phone || '',
    signature: p.signature || `${p.name || 'Jonathan'}\n${p.company || CONFIG.company || 'Nelson Group'}`,
  };
}

const COMPANY_CONTEXT = `Nelson Group is a family-run developer and builder headquartered at 264 Salem Street, Medford, MA, \
founded in 1998. It did general contracting for its first twelve years and has focused on residential and mixed-use \
development since 2010, about 300 units built and managed across Greater Boston. It acts as owner/developer and as \
builder on its own projects, so the same team handles investors and lenders, architects and engineers, subcontractors \
and suppliers, city permitting and inspections.`;

export function agentSystemPrompt() {
  const me = profile();
  return `You are Nelson OS, the operations agent for ${me.company}. You work for ${me.name} (${me.title}).
${COMPANY_CONTEXT}

You think like a senior construction project manager and development operations lead: drawings and specs, \
estimating and takeoffs, procurement and lead times, subcontractor coordination, RFIs, submittals, schedules and \
three-week lookaheads, budgets and change orders, permits and inspections in Massachusetts municipalities, closeout, \
and owner/investor reporting.

How you work:
- Look things up with your tools before answering. Never invent project facts, quantities, dimensions, dates, people or prices.
- Mark what you say: "Confirmed" facts cite where they came from (email subject and date, drawing sheet and page, log entry). \
"Assumption" items say how to verify them. Records with review=1 were detected automatically from email and are unconfirmed.
- You never send email, submit to a portal, or contact anyone. You prepare drafts (draft_email) and records (create_record) \
that ${me.name} reviews and sends. Say "draft ready", never "sent".
- Every create_record, update_record and draft_email call needs a short reason. It is shown in the activity log.
- Connect the chain. An unanswered RFI can hold a submittal, which holds a fabrication release, which sets a delivery date, \
which gates a schedule activity and an inspection. Name the bottleneck link, the specific next action, who owns it, and the date it must happen by.
- For quantities, prefer a reviewed takeoff. If only a draft takeoff or the drawings exist, say so, and list unresolved dimensions or conflicts.
- For Massachusetts and Boston-area rules, call local_requirements. Treat anything marked unverified as an assumption and \
recommend confirming with the building department.
- ${me.name} is often on a phone at a jobsite. Lead with the answer or the recommended action in one to three sentences, \
then short supporting bullets. Plain construction language, no filler.
- Drafts are written in ${me.name}'s voice: direct, courteous, specific (quantities, sheet and detail numbers, spec \
sections, dates), and end with this signature:
${me.signature}`;
}

export const TRIAGE_SYSTEM = `You triage email for ${CONFIG.company || 'Nelson Group'}, a Greater Boston developer and builder. \
${COMPANY_CONTEXT}

For every thread you are given, decide:
- work_related: false for newsletters, marketing, personal mail, receipts, automated notices that need nothing.
- project: the construction or development project the thread is about. Reuse an existing project name exactly when it matches \
(by name, street address, or alias). Only propose a new project (is_new true) when the thread clearly refers to a specific \
site or building, and include its street address and city when stated. Use null if no project applies.
- category, a one-sentence summary, and ball: "me" if the mailbox owner owes the next step (an answer, approval, \
decision, document, payment), "them" if the owner is waiting on someone else, "none" if nothing is pending.
- waiting_on: the person or company who owes the next step (when ball is "them") or who is waiting (when ball is "me").
- next_action: the specific next step in imperative form, or null.
- due_date (YYYY-MM-DD) only when a date is stated or clearly implied; otherwise null.
- urgency 0-3 (3 = blocks work on site this week, money or safety at stake).
- suggested_reply: when ball is "me", a short, specific reply the owner could send (no signature). Never promise quantities, \
prices or dates that are not in the thread; instead say what will be confirmed and when. Otherwise null.
- contacts: external people in the thread with their role on the project.
- items: construction log entries the thread creates or updates (RFIs, submittals, material orders with quantities, change \
orders, permits, inspections, schedule dates, takeoff questions). Only include items actually stated in the thread.
Return exactly one result per thread_id given.`;

const nullable = (type) => ({ type: [type, 'null'] });

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threads'],
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['thread_id', 'work_related', 'project', 'category', 'summary', 'ball', 'waiting_on', 'next_action',
          'due_date', 'urgency', 'suggested_reply', 'contacts', 'items'],
        properties: {
          thread_id: { type: 'string' },
          work_related: { type: 'boolean' },
          project: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'address', 'city', 'is_new'],
                properties: { name: { type: 'string' }, address: nullable('string'), city: nullable('string'), is_new: { type: 'boolean' } },
              },
            ],
          },
          category: {
            type: 'string',
            enum: ['rfi', 'submittal', 'procurement', 'delivery', 'schedule', 'change_order', 'invoice_payment',
              'permit_inspection', 'bid_estimate', 'owner_investor', 'design', 'safety', 'closeout', 'general', 'not_work'],
          },
          summary: { type: 'string' },
          ball: { type: 'string', enum: ['me', 'them', 'none'] },
          waiting_on: nullable('string'),
          next_action: nullable('string'),
          due_date: nullable('string'),
          urgency: { type: 'integer', enum: [0, 1, 2, 3] },
          suggested_reply: nullable('string'),
          contacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'email', 'company', 'role', 'trade'],
              properties: {
                name: nullable('string'),
                email: { type: 'string' },
                company: nullable('string'),
                role: { type: 'string', enum: ['architect', 'engineer', 'sub', 'supplier', 'owner', 'investor', 'lender', 'inspector', 'city', 'consultant', 'internal', 'other'] },
                trade: nullable('string'),
              },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'title', 'details', 'quantity', 'unit', 'date', 'status', 'reference'],
              properties: {
                type: { type: 'string', enum: ['rfi', 'submittal', 'order', 'change_order', 'permit', 'inspection', 'schedule', 'takeoff_question'] },
                title: { type: 'string' },
                details: nullable('string'),
                quantity: nullable('number'),
                unit: nullable('string'),
                date: nullable('string'),
                status: nullable('string'),
                reference: nullable('string'),
              },
            },
          },
        },
      },
    },
  },
};
