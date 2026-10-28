// Drawing and spec PDFs: per-page text index with sheet detection, and
// question answering that sends only the relevant pages to the AI (with page citations).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Worker } from 'node:worker_threads';
import { db, get, indexText, insert, logActivity, newId, search, transaction, update } from '../db.js';
import { FILES_DIR, relativeDocPath, resolveDocPath } from '../paths.js';
import { createMessage, engineStatus, complete } from '../ai/engine.js';
import { askWithLocalAgent } from '../ai/cli-agent.js';

/** Save an uploaded PDF and index it in the background. */
export function addDocument({ projectId, filename, bytes, kind = 'drawings', source = 'upload' }) {
  const id = newId('doc');
  const dir = path.join(FILES_DIR, projectId || 'general');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.pdf`);
  fs.writeFileSync(file, bytes);
  const doc = insert('documents', { id, project_id: projectId, filename, kind, size: bytes.length, path: relativeDocPath(file), status: 'indexing', source });
  logActivity({ actor: source === 'upload' ? 'user' : 'agent', kind: 'document', project_id: projectId, title: `Added ${filename}`, why: source === 'upload' ? 'Uploaded.' : `Imported from ${source}.`, entity_type: 'documents', entity_id: id });
  indexDocument(id).catch((err) => update('documents', id, { status: 'error', error: err.message }));
  return doc;
}

// One document at a time, each in its own worker thread, so indexing never blocks the app.
let queue = Promise.resolve();
export function indexDocument(docId) {
  const run = queue.then(() => indexInWorker(docId));
  queue = run.catch(() => {});
  return run;
}

function indexInWorker(docId) {
  const doc = get('documents', docId);
  if (!doc) return Promise.resolve(null);
  const file = resolveDocPath(doc.path);
  if (!fs.existsSync(file)) {
    update('documents', docId, { status: 'error', error: 'The PDF file is missing. Upload it again.' });
    return Promise.resolve(get('documents', docId));
  }
  db.prepare('DELETE FROM doc_pages WHERE doc_id = ?').run(docId);
  db.prepare("DELETE FROM search_fts WHERE kind = 'doc_page' AND ref_id LIKE ?").run(`${docId}:%`);
  update('documents', docId, { status: 'indexing', error: null });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), { workerData: { file } });
    const sheets = [];
    let pageCount = 0;
    let chars = 0;
    worker.on('message', (m) => {
      if (m.type === 'start') pageCount = m.pages;
      if (m.type === 'page') {
        const pageId = `${docId}:${m.page}`;
        transaction(() => {
          db.prepare('INSERT OR REPLACE INTO doc_pages (id, doc_id, project_id, page, sheet, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(pageId, docId, doc.project_id, m.page, m.sheet, m.title, m.text);
          indexText('doc_page', pageId, doc.project_id, `${doc.filename} page ${m.page} ${m.sheet || ''} ${m.title || ''}`, m.text);
        });
        if (m.sheet) sheets.push(m.sheet);
        chars += m.text.length;
      }
      if (m.type === 'done') {
        // Scanned sets have no selectable text; questions then need a sheet or page number.
        const scanned = pageCount > 0 && chars < pageCount * 40;
        update('documents', docId, { status: 'ready', pages: pageCount, discipline: guessDiscipline(sheets, doc.filename), error: scanned ? 'scanned' : null });
        resolve(get('documents', docId));
      }
    });
    worker.on('error', (err) => {
      update('documents', docId, { status: 'error', error: `Could not read this PDF (${err.message}). If it is password-protected, save an unlocked copy and upload that.` });
      reject(err);
    });
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`PDF reader stopped (${code})`)); });
  });
}

function guessDiscipline(sheets, filename) {
  const letters = sheets.map((s) => s[0]);
  const top = Object.entries(letters.reduce((m, l) => ({ ...m, [l]: (m[l] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
  const map = { A: 'Architectural', S: 'Structural', M: 'Mechanical', E: 'Electrical', P: 'Plumbing', C: 'Civil', L: 'Landscape', F: 'Fire protection', G: 'General' };
  if (top && map[top]) return sheets.length > 3 && new Set(letters).size > 2 ? 'Multi-discipline' : map[top];
  if (/spec/i.test(filename)) return 'Specifications';
  return null;
}

export function documentPages(docId) {
  return db.prepare('SELECT id, page, sheet, title, substr(text, 1, 400) AS excerpt FROM doc_pages WHERE doc_id = ? ORDER BY page').all(docId);
}

// Pick the pages most likely to answer the question: explicit sheet numbers first, then full-text hits.
export function relevantPages(projectId, question, max = 5) {
  const picked = new Map();
  const sheetRefs = String(question).toUpperCase().match(/\b[A-Z]{1,3}-?\d{1,3}(?:\.\d{1,3})?\b/g) || [];
  for (const ref of sheetRefs) {
    const rows = db.prepare(`SELECT p.*, d.filename, d.path FROM doc_pages p JOIN documents d ON d.id = p.doc_id
      WHERE p.project_id IS ? AND REPLACE(UPPER(p.sheet), '-', '') = REPLACE(?, '-', '') LIMIT 2`).all(projectId ?? null, ref);
    for (const r of rows) picked.set(r.id, r);
  }
  // "page 12" works even for scanned sets that have no readable sheet numbers.
  for (const m of String(question).matchAll(/\bpage\s+(\d{1,4})\b/gi)) {
    const rows = db.prepare(`SELECT p.*, d.filename, d.path FROM doc_pages p JOIN documents d ON d.id = p.doc_id
      WHERE p.project_id IS ? AND p.page = ? ORDER BY d.updated_at DESC LIMIT 1`).all(projectId ?? null, Number(m[1]));
    for (const r of rows) picked.set(r.id, r);
  }
  for (const hit of search(question, { projectId, kinds: ['doc_page'], limit: max * 2 })) {
    if (picked.size >= max) break;
    const row = db.prepare('SELECT p.*, d.filename, d.path FROM doc_pages p JOIN documents d ON d.id = p.doc_id WHERE p.id = ?').get(hit.ref_id);
    if (row) picked.set(row.id, row);
  }
  return [...picked.values()].slice(0, max);
}

const pdfCache = new Map();
async function loadPdf(stored) {
  const file = resolveDocPath(stored);
  if (!pdfCache.has(file)) {
    if (pdfCache.size > 2) pdfCache.delete(pdfCache.keys().next().value);
    pdfCache.set(file, await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true, updateMetadata: false }));
  }
  return pdfCache.get(file);
}

export async function extractPage(file, pageNumber) {
  const src = await loadPdf(file);
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageNumber - 1]);
  out.addPage(copied);
  return Buffer.from(await out.save());
}

const label = (p) => `${p.filename}, page ${p.page}${p.sheet ? ` (sheet ${p.sheet}${p.title ? ` ${p.title}` : ''})` : ''}`;

const DRAWING_PROMPT = `Answer the question using only the drawing and specification pages provided.
- Give the direct answer first (quantity, dimension, product, note), then how you got it.
- Count carefully from plans and schedules; say which sheet each number comes from.
- List anything unresolved: dimensions not shown, conflicts between sheets, items "by others", or missing pages you would need.
- If the pages don't contain the answer, say so plainly and say which sheet would.`;

/** Answer a question about a project's drawings with page-level citations. */
export async function askDrawings(projectId, question) {
  const pages = relevantPages(projectId, question);
  if (!pages.length) {
    const hasDocs = db.prepare('SELECT COUNT(*) n FROM documents WHERE project_id IS ?').get(projectId ?? null).n;
    return { answer: hasDocs ? 'No drawing or spec pages matched that question. Try naming the sheet (for example A-201) or the item as it is labeled on the drawings.' : 'This project has no drawings or specs yet. Upload the current set on the project\'s Documents tab.', sources: [], mode: 'none' };
  }
  const sources = pages.map((p) => ({ doc_id: p.doc_id, filename: p.filename, page: p.page, sheet: p.sheet, title: p.title }));
  const { engine } = await engineStatus();

  if (engine === 'anthropic') {
    const blocks = [];
    let total = 0;
    for (const p of pages) {
      const bytes = await extractPage(p.path, p.page);
      if (total + bytes.length > 24 * 1024 * 1024) break; // stay under the 32 MB request limit
      total += bytes.length;
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: label(p), citations: { enabled: true } });
    }
    const res = await createMessage({
      max_tokens: 8000,
      output_config: { effort: 'high' },
      system: DRAWING_PROMPT,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: question }] }],
    });
    let answer = '';
    const quotes = [];
    for (const b of res.content) {
      if (b.type !== 'text') continue;
      answer += b.text;
      for (const c of b.citations || []) {
        const p = pages[c.document_index];
        if (p) quotes.push({ doc_id: p.doc_id, filename: p.filename, page: p.page, sheet: p.sheet, quote: c.cited_text?.slice(0, 200) });
      }
    }
    return { answer: answer.trim(), sources, quotes, mode: 'vision' };
  }

  if (engine === 'claude-cli') {
    // Claude Code can read PDF pages itself, so it sees the actual drawings.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-os-pages-'));
    try {
      const files = [];
      for (const p of pages) {
        const f = path.join(dir, `page-${p.page}${p.sheet ? `-${p.sheet.replace(/[^\w.-]/g, '')}` : ''}.pdf`);
        fs.writeFileSync(f, await extractPage(p.path, p.page));
        files.push(`- ${f}  =  ${label(p)}`);
      }
      const answer = await askWithLocalAgent({
        prompt: `${DRAWING_PROMPT}\n\nRead each of these PDF pages with the Read tool, then answer. Cite pages as [filename, page N, sheet X].\n${files.join('\n')}\n\nQuestion: ${question}`,
        readDir: dir,
      });
      return { answer, sources, mode: 'vision' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (engine === 'codex-cli') {
    const answer = await complete({
      system: DRAWING_PROMPT,
      prompt: `Question: ${question}\n\nCite pages as [filename, page N].`,
      documents: pages.map((p) => ({ text: `### ${label(p)}\n${p.text.slice(0, 12000)}` })),
    });
    return { answer, sources, mode: 'text' };
  }

  return {
    answer: 'Connect an AI engine (Connections) to get answers. These pages look most relevant:',
    sources: pages.map((p) => ({ ...sourcesFor(p), excerpt: p.text.slice(0, 300) })),
    mode: 'search',
  };
}

const sourcesFor = (p) => ({ doc_id: p.doc_id, filename: p.filename, page: p.page, sheet: p.sheet, title: p.title });
