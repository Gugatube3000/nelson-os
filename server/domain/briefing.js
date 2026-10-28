import { db, list, recentActivity, today } from '../db.js';
import { budgetSummary, projectCounts } from './projects.js';
import { addDays, computeRisks, daysBetween, returnDue } from './risks.js';

const WAITING_RFI = ['sent'];

/** Everything the command center needs in one payload. */
export function briefing({ projectId } = {}) {
  const t = today();
  const f = projectId ? { project_id: projectId } : {};
  const projects = list('projects', { ...f.project_id ? { id: projectId } : {}, status: 'active' }, { order: 'name' });
  const names = Object.fromEntries(list('projects').map((p) => [p.id, p.name]));
  const risks = computeRisks(projectId);
  const threads = list('threads', { ...f, status: 'open', work: 1 }, { order: 'last_at DESC' });
  const actions = list('actions', { ...f, status: 'open' });

  const waitingOnMe = [
    ...threads.filter((th) => th.ball === 'me').map((th) => ({
      type: 'threads', id: th.id, project_id: th.project_id, project: names[th.project_id] || null,
      who: th.waiting_on, what: th.next_action || th.subject, subject: th.subject,
      since: th.last_at, age: daysBetween((th.last_at || t).slice(0, 10), t), urgency: th.urgency,
      hasReply: !!th.suggested_reply,
    })),
    ...actions.filter((a) => a.direction === 'on_me' && !a.thread_id).map((a) => ({
      type: 'actions', id: a.id, project_id: a.project_id, project: names[a.project_id] || null,
      who: a.counterparty, what: a.title, since: a.created_at, due: a.due_date,
      age: daysBetween((a.created_at || t).slice(0, 10), t), urgency: a.priority,
    })),
  ].sort((a, b) => (b.urgency || 0) - (a.urgency || 0) || b.age - a.age);

  const waitingOnOthers = [
    ...threads.filter((th) => th.ball === 'them').map((th) => ({
      type: 'threads', id: th.id, project_id: th.project_id, project: names[th.project_id] || null,
      who: th.waiting_on, what: th.next_action || th.subject, since: th.last_at,
      age: daysBetween((th.last_at || t).slice(0, 10), t),
    })),
    ...list('rfis', f).filter((r) => WAITING_RFI.includes(r.status)).map((r) => ({
      type: 'rfis', id: r.id, project_id: r.project_id, project: names[r.project_id] || null,
      who: r.to_name || 'Architect', what: `RFI-${String(r.number).padStart(3, '0')} ${r.subject}`,
      since: r.date_sent, due: r.date_required, overdue: !!(r.date_required && r.date_required < t),
      age: r.date_sent ? daysBetween(r.date_sent, t) : 0,
    })),
    ...list('submittals', { ...f, status: 'submitted' }).map((s) => ({
      type: 'submittals', id: s.id, project_id: s.project_id, project: names[s.project_id] || null,
      who: s.reviewer_name || 'Architect', what: `Submittal ${s.number || ''} ${s.title}`.replace(/\s+/g, ' '),
      since: s.date_submitted, due: returnDue(s), overdue: !!(returnDue(s) && returnDue(s) < t),
      age: s.date_submitted ? daysBetween(s.date_submitted, t) : 0,
    })),
    ...list('orders', f).filter((o) => ['ordered', 'in_fabrication', 'shipped'].includes(o.status)).map((o) => ({
      type: 'orders', id: o.id, project_id: o.project_id, project: names[o.project_id] || null,
      who: o.supplier || 'Supplier', what: `Deliver ${o.item}`, due: o.expected_delivery || o.need_by,
      overdue: !!(o.need_by && o.need_by < t), age: 0,
    })),
    ...actions.filter((a) => a.direction === 'on_them').map((a) => ({
      type: 'actions', id: a.id, project_id: a.project_id, project: names[a.project_id] || null,
      who: a.counterparty, what: a.title, due: a.due_date, age: daysBetween((a.created_at || t).slice(0, 10), t),
    })),
  ].sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || b.age - a.age);

  const horizon = addDays(t, 21);
  const lookahead = [
    ...list('schedule_items', f).filter((a) => a.status !== 'complete' && a.start && a.start <= horizon && (a.finish || a.start) >= t)
      .map((a) => ({ type: 'schedule_items', id: a.id, date: a.start, end: a.finish, title: a.name, project: names[a.project_id], project_id: a.project_id, who: a.responsible, status: a.status })),
    ...list('inspections', f).filter((i) => i.scheduled_for && i.scheduled_for >= t && i.scheduled_for <= horizon)
      .map((i) => ({ type: 'inspections', id: i.id, date: i.scheduled_for, title: `${i.kind} inspection`, project: names[i.project_id], project_id: i.project_id, who: i.inspector, status: i.status })),
    ...list('orders', f).filter((o) => o.expected_delivery && o.expected_delivery >= t && o.expected_delivery <= horizon && !['delivered', 'installed'].includes(o.status))
      .map((o) => ({ type: 'orders', id: o.id, date: o.expected_delivery, title: `Delivery: ${o.item}`, project: names[o.project_id], project_id: o.project_id, who: o.supplier, status: o.status })),
    ...(projectId ? [] : db.prepare('SELECT * FROM calendar_events WHERE start >= ? AND start <= ? ORDER BY start').all(t, `${horizon}T23:59`)
      .map((e) => ({ type: 'calendar', id: e.id, date: e.start.slice(0, 10), time: e.start.slice(11, 16), title: e.subject, project: names[e.project_id] || null, who: e.location, link: e.web_link }))),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const suggestedReplies = threads.filter((th) => th.ball === 'me' && th.suggested_reply).slice(0, 8).map((th) => ({
    id: th.id, subject: th.subject, who: th.waiting_on, project: names[th.project_id] || null, reply: th.suggested_reply,
  }));

  const riskCount = (pid, sev) => risks.filter((r) => r.project_id === pid && r.severity === sev).length;
  const projectRows = projects.map((p) => ({
    ...p,
    counts: projectCounts(p.id),
    budget: budgetSummary(p.id),
    risks: { high: riskCount(p.id, 'high'), medium: riskCount(p.id, 'medium') },
  }));

  const unconfirmed = ['rfis', 'submittals', 'orders', 'changes', 'permits', 'inspections', 'schedule_items', 'projects']
    .reduce((n, tbl) => n + (db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE review = 1${projectId && tbl !== 'projects' ? ' AND project_id = ?' : ''}`).get(...(projectId && tbl !== 'projects' ? [projectId] : []))?.n || 0), 0);

  return {
    date: t,
    counts: {
      projects: projects.length,
      high: risks.filter((r) => r.severity === 'high').length,
      waitingOnMe: waitingOnMe.length,
      waitingOnOthers: waitingOnOthers.length,
      overdue: waitingOnOthers.filter((w) => w.overdue).length,
      unconfirmed,
    },
    attention: risks.filter((r) => r.severity !== 'low').slice(0, 12),
    risks,
    waitingOnMe,
    waitingOnOthers,
    lookahead,
    suggestedReplies,
    projects: projectRows,
    activity: recentActivity({ projectId, limit: 12 }),
    // Answers, returns, slips and new items from the last three days: what changed while you were out.
    changes: db.prepare(`SELECT id, at, kind, title, detail, project_id, entity_type, entity_id FROM activity_log
      WHERE kind IN ('change', 'detected') AND at >= ?${projectId ? ' AND project_id = ?' : ''} ORDER BY id DESC LIMIT 30`)
      .all(new Date(Date.now() - 3 * 86400000).toISOString(), ...(projectId ? [projectId] : []))
      .map((c) => ({ ...c, project: names[c.project_id] || null })),
  };
}

/** Plain-text digest used by the agent tools and the MCP server. */
export function briefingText(b = briefing()) {
  const lines = [`Briefing for ${b.date}: ${b.counts.projects} active projects, ${b.counts.high} high risks, ${b.counts.waitingOnMe} waiting on you, ${b.counts.waitingOnOthers} you're waiting on.`];
  if (b.attention.length) {
    lines.push('', 'Needs attention:');
    for (const r of b.attention) lines.push(`- [${r.severity}] ${r.project ? `${r.project}: ` : ''}${r.title}. Why: ${r.why.join(' ')} Next: ${r.recommendation}`);
  }
  if (b.waitingOnMe.length) {
    lines.push('', 'Waiting on you:');
    for (const w of b.waitingOnMe.slice(0, 15)) lines.push(`- ${w.who || '?'} (${w.age}d): ${w.what}${w.project ? ` [${w.project}]` : ''} (${w.type}:${w.id})`);
  }
  if (b.waitingOnOthers.length) {
    lines.push('', "You're waiting on:");
    for (const w of b.waitingOnOthers.slice(0, 15)) lines.push(`- ${w.who || '?'}: ${w.what}${w.due ? ` due ${w.due}` : ''}${w.overdue ? ' OVERDUE' : ''}${w.project ? ` [${w.project}]` : ''}`);
  }
  if (b.lookahead.length) {
    lines.push('', 'Next 3 weeks:');
    for (const l of b.lookahead.slice(0, 15)) lines.push(`- ${l.date}${l.time ? ` ${l.time}` : ''}: ${l.title}${l.project ? ` [${l.project}]` : ''}`);
  }
  return lines.join('\n');
}
