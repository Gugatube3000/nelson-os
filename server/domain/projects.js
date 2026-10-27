import { db, get, insert, list, logActivity, update } from '../db.js';

export const norm = (s) => String(s || '').toLowerCase()
  .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const ADDRESS_RE = /\b(\d{1,5}(?:-\d{1,5})?\s+(?:[A-Z][a-zA-Z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Way|Blvd|Ln|Lane|Ct|Court|Pl|Place|Dr|Drive|Pkwy|Sq|Square|Ter|Terrace|Hwy|Pk|Park|Row))\b\.?/;

export function findAddress(text) {
  const m = String(text || '').match(ADDRESS_RE);
  return m ? m[1].trim() : null;
}

function keysFor(p) {
  return [p.name, p.address, p.code, ...(p.aliases || [])].map(norm).filter((k) => k.length >= 4);
}

/** Resolve a project from an id, a name, an alias, or an address mentioned in text. */
export function resolveProject(ref) {
  if (!ref) return null;
  if (typeof ref === 'string' && ref.startsWith('prj_')) return get('projects', ref);
  const needle = norm(ref);
  if (!needle) return null;
  const projects = list('projects');
  let best = null;
  for (const p of projects) {
    for (const key of keysFor(p)) {
      if (needle === key) return p;
      if (needle.includes(key) || key.includes(needle)) {
        if (!best || key.length > best.len) best = { p, len: key.length };
      }
    }
  }
  return best?.p || null;
}

/** Find a project mentioned anywhere in a block of text (subject + body). */
export function projectInText(text) {
  const hay = ` ${norm(text)} `;
  let best = null;
  for (const p of list('projects')) {
    for (const key of keysFor(p)) {
      if (hay.includes(` ${key} `) && (!best || key.length > best.len)) best = { p, len: key.length };
    }
  }
  return best?.p || null;
}

export function findOrCreateProject({ name, address, city, source = 'email', why, sources }) {
  const existing = resolveProject(address) || resolveProject(name);
  if (existing) {
    if (address && !existing.address) update('projects', existing.id, { address });
    return existing;
  }
  const project = insert('projects', {
    name: name || address,
    address: address || null,
    city: city || null,
    status: 'active',
    phase: null,
    source,
    review: source === 'manual' ? 0 : 1,
    created_by: source === 'manual' ? 'user' : 'agent',
    aliases: address && name && norm(address) !== norm(name) ? [address] : [],
  });
  logActivity({
    kind: 'project_detected',
    project_id: project.id,
    title: `Added project "${project.name}"`,
    why: why || 'It appeared in project email.',
    sources,
    entity_type: 'projects',
    entity_id: project.id,
  });
  return project;
}

export function projectCounts(projectId) {
  const one = (sql) => db.prepare(sql).get(projectId)?.n ?? 0;
  return {
    openRfis: one(`SELECT COUNT(*) n FROM rfis WHERE project_id = ? AND status IN ('draft','sent')`),
    openSubmittals: one(`SELECT COUNT(*) n FROM submittals WHERE project_id = ? AND status NOT IN ('approved','approved_as_noted','closed')`),
    openOrders: one(`SELECT COUNT(*) n FROM orders WHERE project_id = ? AND status NOT IN ('delivered','installed')`),
    replyOwed: one(`SELECT COUNT(*) n FROM threads WHERE project_id = ? AND ball = 'me' AND status = 'open' AND work = 1`),
    documents: one(`SELECT COUNT(*) n FROM documents WHERE project_id = ?`),
    pendingChanges: one(`SELECT COUNT(*) n FROM changes WHERE project_id = ? AND status IN ('potential','pending')`),
  };
}

export function budgetSummary(projectId) {
  const p = get('projects', projectId) || {};
  const sum = (sql) => db.prepare(sql).get(projectId)?.total ?? 0;
  const approved = sum(`SELECT COALESCE(SUM(amount),0) total FROM changes WHERE project_id = ? AND status = 'approved'`);
  const pending = sum(`SELECT COALESCE(SUM(amount),0) total FROM changes WHERE project_id = ? AND status IN ('potential','pending')`);
  const committed = sum(`SELECT COALESCE(SUM(cost),0) total FROM orders WHERE project_id = ? AND status NOT IN ('quote')`);
  return {
    contract: p.contract_value ?? null,
    budget: p.budget ?? null,
    contingency: p.contingency ?? null,
    approvedChanges: approved,
    pendingChanges: pending,
    committed,
    contingencyRemaining: p.contingency != null ? p.contingency - approved : null,
  };
}
