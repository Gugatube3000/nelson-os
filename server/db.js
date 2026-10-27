import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './paths.js';

export const db = new DatabaseSync(process.env.NELSON_OS_DB || path.join(DATA_DIR, 'nelson-os.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// Columns shared by every construction log: where the record came from and
// whether a person has confirmed it (review = 1 means "detected, not yet confirmed").
const PROVENANCE = `source TEXT DEFAULT 'manual', review INTEGER DEFAULT 0, created_by TEXT DEFAULT 'user',
  created_at TEXT, updated_at TEXT`;

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, address TEXT, city TEXT, type TEXT, phase TEXT,
  status TEXT DEFAULT 'active', client TEXT, description TEXT, start_date TEXT, target_completion TEXT,
  contract_value REAL, budget REAL, contingency REAL, aliases TEXT DEFAULT '[]', ${PROVENANCE});

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, name TEXT, email TEXT, company TEXT, role TEXT, trade TEXT, phone TEXT,
  project_id TEXT, notes TEXT, ${PROVENANCE});
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(lower(email)) WHERE email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, thread_id TEXT, project_id TEXT, folder TEXT, subject TEXT, from_name TEXT,
  from_email TEXT, to_json TEXT, cc_json TEXT, received_at TEXT, from_me INTEGER DEFAULT 0, body_text TEXT,
  preview TEXT, has_attachments INTEGER DEFAULT 0, attachments_json TEXT, web_link TEXT, importance TEXT,
  created_at TEXT);
CREATE INDEX IF NOT EXISTS emails_thread ON emails(thread_id, received_at);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, project_id TEXT, subject TEXT, last_at TEXT, last_from_me INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0, participants_json TEXT, category TEXT, summary TEXT,
  ball TEXT DEFAULT 'none', waiting_on TEXT, next_action TEXT, suggested_reply TEXT, urgency INTEGER DEFAULT 0,
  due_date TEXT, status TEXT DEFAULT 'open', work INTEGER DEFAULT 1, triage_source TEXT, triaged_at TEXT,
  created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, project_id TEXT, thread_id TEXT, kind TEXT, title TEXT, detail TEXT,
  direction TEXT DEFAULT 'on_me', counterparty TEXT, due_date TEXT, status TEXT DEFAULT 'open',
  priority INTEGER DEFAULT 1, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS rfis (
  id TEXT PRIMARY KEY, project_id TEXT, number INTEGER, subject TEXT, question TEXT, proposed_solution TEXT,
  drawing_refs TEXT, spec_refs TEXT, to_name TEXT, to_email TEXT, cc TEXT, status TEXT DEFAULT 'draft',
  date_sent TEXT, date_required TEXT, date_answered TEXT, answer TEXT, cost_impact TEXT DEFAULT 'tbd',
  schedule_impact TEXT DEFAULT 'tbd', thread_id TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS submittals (
  id TEXT PRIMARY KEY, project_id TEXT, number TEXT, spec_section TEXT, title TEXT, kind TEXT,
  supplier TEXT, reviewer_name TEXT, reviewer_email TEXT, status TEXT DEFAULT 'not_started',
  required_onsite TEXT, lead_time_days INTEGER, review_days INTEGER DEFAULT 14, date_submitted TEXT,
  date_returned TEXT, rfi_id TEXT, notes TEXT, thread_id TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, project_id TEXT, item TEXT, spec_section TEXT, quantity REAL, unit TEXT, supplier TEXT,
  supplier_email TEXT, po_number TEXT, status TEXT DEFAULT 'quote', lead_time_days INTEGER, need_by TEXT,
  expected_delivery TEXT, delivered_on TEXT, cost REAL, submittal_id TEXT, takeoff_id TEXT, notes TEXT,
  thread_id TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS takeoffs (
  id TEXT PRIMARY KEY, project_id TEXT, item TEXT, spec_section TEXT, quantity REAL, unit TEXT, location TEXT,
  doc_id TEXT, page INTEGER, status TEXT DEFAULT 'draft', unresolved TEXT, notes TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY, project_id TEXT, name TEXT, trade TEXT, start TEXT, finish TEXT,
  status TEXT DEFAULT 'not_started', percent INTEGER DEFAULT 0, responsible TEXT,
  predecessor_ids TEXT DEFAULT '[]', submittal_ids TEXT DEFAULT '[]', order_ids TEXT DEFAULT '[]',
  rfi_ids TEXT DEFAULT '[]', inspection TEXT, notes TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, project_id TEXT, number INTEGER, title TEXT, description TEXT, amount REAL,
  status TEXT DEFAULT 'potential', reason TEXT, rfi_id TEXT, date_submitted TEXT, date_approved TEXT,
  thread_id TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS permits (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, number TEXT, jurisdiction TEXT, status TEXT DEFAULT 'preparing',
  applied_on TEXT, issued_on TEXT, expires_on TEXT, notes TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY, project_id TEXT, permit_id TEXT, kind TEXT, scheduled_for TEXT,
  status TEXT DEFAULT 'needed', inspector TEXT, schedule_item_id TEXT, notes TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, project_id TEXT, filename TEXT, kind TEXT, discipline TEXT, revision TEXT,
  pages INTEGER, size INTEGER, path TEXT, status TEXT DEFAULT 'indexing', error TEXT, ${PROVENANCE});

CREATE TABLE IF NOT EXISTS doc_pages (
  id TEXT PRIMARY KEY, doc_id TEXT, project_id TEXT, page INTEGER, sheet TEXT, title TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS doc_pages_doc ON doc_pages(doc_id, page);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, project_id TEXT, to_json TEXT, cc_json TEXT, subject TEXT, body TEXT,
  attachments_json TEXT DEFAULT '[]', related_type TEXT, related_id TEXT, thread_id TEXT,
  status TEXT DEFAULT 'draft', ${PROVENANCE});

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, subject TEXT, start TEXT, end TEXT, location TEXT, organizer TEXT, project_id TEXT,
  web_link TEXT, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT, project_id TEXT, messages_json TEXT DEFAULT '[]', display_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, kind TEXT, project_id TEXT, title TEXT,
  detail TEXT, why TEXT, sources_json TEXT, entity_type TEXT, entity_id TEXT);

-- Changes to outside systems (Procore) wait here until Jonathan approves them.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, system TEXT, project_id TEXT, title TEXT, detail TEXT, method TEXT, path TEXT,
  path_params_json TEXT, body_json TEXT, notifies TEXT, reason TEXT, status TEXT DEFAULT 'pending',
  result TEXT, ${PROVENANCE}, decided_at TEXT);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED, title, body, tokenize = 'porter unicode61');
`);

// Columns added after the first release; safe to run on every start.
function addColumn(table, column, type) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
for (const t of ['projects', 'rfis', 'submittals', 'schedule_items', 'changes']) {
  addColumn(t, 'procore_id', 'TEXT');
  addColumn(t, 'ext_url', 'TEXT');
}

export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// ---------- settings ----------
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- generic entity CRUD ----------
// prefix: id prefix; json: columns stored as JSON text; numbered: per-project sequence column.
export const ENTITIES = {
  projects: { prefix: 'prj', json: ['aliases'] },
  contacts: { prefix: 'con', json: [] },
  threads: { prefix: 'thr', json: ['participants_json'] },
  actions: { prefix: 'act', json: [] },
  rfis: { prefix: 'rfi', json: [], numbered: 'number' },
  submittals: { prefix: 'sub', json: [] },
  orders: { prefix: 'ord', json: [] },
  takeoffs: { prefix: 'tko', json: [] },
  schedule_items: { prefix: 'sch', json: ['predecessor_ids', 'submittal_ids', 'order_ids', 'rfi_ids'] },
  changes: { prefix: 'chg', json: [], numbered: 'number' },
  permits: { prefix: 'pmt', json: [] },
  inspections: { prefix: 'ins', json: [] },
  documents: { prefix: 'doc', json: [] },
  drafts: { prefix: 'drf', json: ['to_json', 'cc_json', 'attachments_json'] },
  approvals: { prefix: 'apr', json: ['path_params_json', 'body_json'] },
};

const columnCache = new Map();
export function columns(table) {
  if (!columnCache.has(table)) {
    columnCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
  }
  return columnCache.get(table);
}

function assertEntity(entity) {
  if (!ENTITIES[entity]) throw Object.assign(new Error(`Unknown record type: ${entity}`), { status: 400 });
  return ENTITIES[entity];
}

export function decode(entity, row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of ENTITIES[entity]?.json || []) {
    if (typeof out[col] === 'string') { try { out[col] = JSON.parse(out[col]); } catch { out[col] = []; } }
  }
  return out;
}

function encode(entity, data) {
  const cols = columns(entity);
  const json = ENTITIES[entity].json;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!cols.has(k) || k === 'id') continue;
    out[k] = json.includes(k) && typeof v !== 'string' ? JSON.stringify(v ?? []) : v === undefined ? null : v;
    if (typeof out[k] === 'boolean') out[k] = out[k] ? 1 : 0;
    if (out[k] !== null && typeof out[k] === 'object') out[k] = JSON.stringify(out[k]);
  }
  return out;
}

export function list(entity, filters = {}, { order, limit } = {}) {
  assertEntity(entity);
  const cols = columns(entity);
  const where = [];
  const params = [];
  for (const [k, v] of Object.entries(filters)) {
    if (!cols.has(k) || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      where.push(`${k} IN (${v.map(() => '?').join(',')})`);
      params.push(...v);
    } else { where.push(`${k} = ?`); params.push(v); }
  }
  const orderBy = order || (cols.has('updated_at') ? 'updated_at DESC' : 'rowid DESC');
  const sql = `SELECT * FROM ${entity}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
  return db.prepare(sql).all(...params).map((r) => decode(entity, r));
}

export function get(entity, id) {
  assertEntity(entity);
  return decode(entity, db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id));
}

export function insert(entity, data) {
  const def = assertEntity(entity);
  const row = encode(entity, data);
  const id = data.id || newId(def.prefix);
  const stamp = now();
  if (columns(entity).has('created_at')) row.created_at = row.created_at || stamp;
  if (columns(entity).has('updated_at')) row.updated_at = stamp;
  if (def.numbered && row[def.numbered] == null) {
    const { n } = db.prepare(`SELECT COALESCE(MAX(${def.numbered}), 0) + 1 AS n FROM ${entity} WHERE project_id IS ?`)
      .get(row.project_id ?? null);
    row[def.numbered] = n;
  }
  const keys = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(id, ...Object.values(row));
  const created = get(entity, id);
  indexRecord(entity, created);
  return created;
}

export function update(entity, id, data) {
  assertEntity(entity);
  const row = encode(entity, data);
  if (columns(entity).has('updated_at')) row.updated_at = now();
  const keys = Object.keys(row);
  if (keys.length) {
    db.prepare(`UPDATE ${entity} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(row), id);
  }
  const updated = get(entity, id);
  if (updated) indexRecord(entity, updated);
  return updated;
}

export function remove(entity, id) {
  assertEntity(entity);
  db.prepare(`DELETE FROM ${entity} WHERE id = ?`).run(id);
  db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(entity, id);
}

// ---------- full-text search ----------
const INDEXED = {
  rfis: (r) => [`RFI ${r.number ?? ''} ${r.subject ?? ''}`, [r.question, r.proposed_solution, r.drawing_refs, r.spec_refs, r.answer, r.to_name]],
  submittals: (r) => [`Submittal ${r.number ?? ''} ${r.title ?? ''}`, [r.spec_section, r.supplier, r.notes, r.reviewer_name]],
  orders: (r) => [`Order ${r.item ?? ''}`, [r.supplier, r.po_number, r.notes, r.spec_section, `${r.quantity ?? ''} ${r.unit ?? ''}`]],
  takeoffs: (r) => [`Takeoff ${r.item ?? ''}`, [r.location, r.unresolved, r.notes, `${r.quantity ?? ''} ${r.unit ?? ''}`]],
  schedule_items: (r) => [`Schedule ${r.name ?? ''}`, [r.trade, r.responsible, r.notes]],
  changes: (r) => [`Change ${r.number ?? ''} ${r.title ?? ''}`, [r.description, r.reason]],
  permits: (r) => [`Permit ${r.kind ?? ''} ${r.number ?? ''}`, [r.jurisdiction, r.notes]],
  contacts: (r) => [`${r.name ?? ''} ${r.company ?? ''}`, [r.email, r.role, r.trade, r.phone]],
  projects: (r) => [`${r.name ?? ''}`, [r.address, r.city, r.description, r.client, (r.aliases || []).join(' ')]],
};

export function indexRecord(entity, row) {
  const fn = INDEXED[entity];
  if (!fn || !row) return;
  const [title, parts] = fn(row);
  db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(entity, row.id);
  db.prepare('INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(entity, row.id, entity === 'projects' ? row.id : row.project_id ?? null, title, parts.filter(Boolean).join('\n'));
}

export function indexText(kind, refId, projectId, title, body) {
  db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
  db.prepare('INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(kind, refId, projectId ?? null, title || '', body || '');
}

// Turn free text into a safe FTS5 query: every word becomes a prefix term, OR-ed together.
export function ftsQuery(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  const stop = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'many', 'are', 'is', 'of', 'on', 'in', 'to', 'do', 'we', 'our', 'any', 'this', 'that', 'from', 'about', 'which', 'there', 'have', 'has', 'need']);
  const terms = [...new Set(words.filter((w) => !stop.has(w)))].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

export function search(text, { projectId, kinds, limit = 20 } = {}) {
  const q = ftsQuery(text);
  if (!q) return [];
  const where = ['search_fts MATCH ?'];
  const params = [q];
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
  return db.prepare(`SELECT kind, ref_id, project_id, title, snippet(search_fts, 4, '[', ']', ' … ', 18) AS snippet,
      bm25(search_fts, 0, 0, 0, 4.0, 1.0) AS score
    FROM search_fts WHERE ${where.join(' AND ')} ORDER BY score LIMIT ${Number(limit)}`).all(...params);
}

// ---------- activity log ----------
export function logActivity({ actor = 'agent', kind = 'note', project_id = null, title, detail = '', why = '', sources = [], entity_type = null, entity_id = null }) {
  db.prepare(`INSERT INTO activity_log (at, actor, kind, project_id, title, detail, why, sources_json, entity_type, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(now(), actor, kind, project_id, title, detail, why, JSON.stringify(sources || []), entity_type, entity_id);
}

export function recentActivity({ projectId, limit = 50 } = {}) {
  const rows = projectId
    ? db.prepare('SELECT * FROM activity_log WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit)
    : db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources_json || '[]') }));
}
