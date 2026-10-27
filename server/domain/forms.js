// Branded RFI and submittal transmittal PDFs, plus Outlook-ready email drafts (.eml).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { get, today } from '../db.js';
import { CONFIG } from '../paths.js';
import { profile } from '../ai/prompts.js';
import { returnDue } from './risks.js';

const MAROON = rgb(0x64 / 255, 0x06 / 255, 0x12 / 255);
const INK = rgb(0x1a / 255, 0x1b / 255, 0x1c / 255);
const GREY = rgb(0.42, 0.44, 0.47);
const RULE = rgb(0.8, 0.81, 0.8);
const W = 612;
const H = 792;
const M = 48;

// Standard PDF fonts only cover WinAnsi; map common Unicode punctuation and drop the rest.
function clean(s) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
    .replace(/[→➔]/g, '->').replace(/ /g, ' ').replace(/\t/g, '    ')
    .replace(/[^\x0A\x20-\x7E -ÿ–—•]/g, '');
}

class Sheet {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.f = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([W, H]);
    this.y = H - M;
  }

  ensure(h) {
    if (this.y - h < M + 30) this.newPage();
  }

  wrap(text, font, size, width) {
    const out = [];
    for (const para of clean(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(tryLine, size) > width && line) { out.push(line); line = word; } else line = tryLine;
      }
      out.push(line);
    }
    return out;
  }

  text(str, { x = M, size = 10, font = this.f.reg, color = INK, width = W - 2 * M, lh = 1.35 } = {}) {
    for (const line of this.wrap(str, font, size, width)) {
      this.ensure(size * lh);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= size * lh;
    }
  }

  rule(color = RULE, thickness = 0.75) {
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness, color });
  }
}

function drawMark(page, x, y, w) {
  // The Nelson Group mark: a maroon frame with two triangles cut away, leaving the N.
  const s = w / 875;
  page.drawRectangle({ x, y, width: 875 * s, height: 412 * s, color: MAROON });
  page.drawSvgPath('M 45 55 L 333 412 L 45 412 Z', { x, y: y + 412 * s, scale: s, color: rgb(1, 1, 1) });
  page.drawSvgPath('M 543 0 L 831 0 L 831 355 Z', { x, y: y + 412 * s, scale: s, color: rgb(1, 1, 1) });
}

async function startDoc(title, number) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${number}`);
  pdf.setProducer('Nelson OS');
  const fonts = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const sh = new Sheet(pdf, fonts);
  const p = sh.page;
  drawMark(p, M, H - M - 30, 64);
  p.drawText(CONFIG.company || 'Nelson Group', { x: M + 74, y: H - M - 14, size: 14, font: fonts.bold, color: INK });
  p.drawText(clean(`${CONFIG.companyAddress || ''}  |  ${CONFIG.companyPhone || ''}`), { x: M + 74, y: H - M - 28, size: 8.5, font: fonts.reg, color: GREY });
  const tw = fonts.bold.widthOfTextAtSize(title, 15);
  p.drawText(title, { x: W - M - tw, y: H - M - 14, size: 15, font: fonts.bold, color: MAROON });
  const nw = fonts.bold.widthOfTextAtSize(clean(number), 11);
  p.drawText(clean(number), { x: W - M - nw, y: H - M - 29, size: 11, font: fonts.bold, color: INK });
  sh.y = H - M - 44;
  sh.rule(MAROON, 1.5);
  sh.y -= 14;
  return sh;
}

function grid(sh, rows) {
  // Two-column label/value grid, like a title block.
  const colW = (W - 2 * M) / 2;
  for (const pair of rows) {
    const heights = pair.map(([, v]) => sh.wrap(v || '—', sh.f.reg, 9.5, colW - 12).length);
    const h = 13 + Math.max(...heights) * 12.5 + 6;
    sh.ensure(h);
    pair.forEach(([label, value], i) => {
      const x = M + i * colW;
      sh.page.drawRectangle({ x, y: sh.y - h, width: colW, height: h, borderColor: RULE, borderWidth: 0.75 });
      sh.page.drawText(clean(label), { x: x + 6, y: sh.y - 11, size: 7.5, font: sh.f.bold, color: GREY });
      let yy = sh.y - 24;
      for (const line of sh.wrap(value || '—', sh.f.reg, 9.5, colW - 12)) {
        sh.page.drawText(line, { x: x + 6, y: yy, size: 9.5, font: sh.f.reg, color: INK });
        yy -= 12.5;
      }
    });
    sh.y -= h;
  }
  sh.y -= 12;
}

function section(sh, heading, body, minLines = 0) {
  sh.ensure(40);
  sh.text(heading, { size: 9, font: sh.f.bold, color: MAROON });
  sh.y -= 2;
  sh.rule();
  sh.y -= 8;
  if (body) sh.text(body, { size: 10 });
  for (let i = 0; i < minLines; i++) {
    sh.ensure(20);
    sh.y -= 18;
    sh.rule();
  }
  sh.y -= 12;
}

function footer(pdf, fonts, label) {
  const pages = pdf.getPages();
  pages.forEach((pg, i) => {
    const txt = clean(`${label}  |  Page ${i + 1} of ${pages.length}  |  Prepared with Nelson OS`);
    pg.drawText(txt, { x: M, y: M - 18, size: 7.5, font: fonts.reg, color: GREY });
  });
}

const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
export const rfiNumber = (r) => `RFI-${String(r.number ?? 0).padStart(3, '0')}`;

export async function rfiPdf(rfiId) {
  const r = get('rfis', rfiId);
  if (!r) throw Object.assign(new Error('RFI not found'), { status: 404 });
  const p = get('projects', r.project_id) || {};
  const me = profile();
  const sh = await startDoc('REQUEST FOR INFORMATION', rfiNumber(r));
  grid(sh, [
    [['PROJECT', p.name], ['ADDRESS', [p.address, p.city].filter(Boolean).join(', ')]],
    [['TO', [r.to_name, r.to_email].filter(Boolean).join('\n')], ['FROM', `${me.name}, ${me.title}\n${me.company}${me.email ? `\n${me.email}` : ''}`]],
    [['DATE', fmt(r.date_sent || today())], ['RESPONSE REQUIRED BY', fmt(r.date_required)]],
    [['DRAWING REFERENCES', r.drawing_refs], ['SPECIFICATION REFERENCES', r.spec_refs]],
    [['POTENTIAL COST IMPACT', (r.cost_impact || 'tbd').toUpperCase()], ['POTENTIAL SCHEDULE IMPACT', (r.schedule_impact || 'tbd').toUpperCase()]],
  ]);
  sh.text(`Subject: ${r.subject || ''}`, { size: 12, font: sh.f.bold });
  sh.y -= 10;
  section(sh, 'QUESTION', r.question || '');
  if (r.proposed_solution) section(sh, "CONTRACTOR'S PROPOSED SOLUTION", r.proposed_solution);
  section(sh, 'RESPONSE (TO BE COMPLETED BY ARCHITECT / ENGINEER)', r.answer || '', r.answer ? 0 : 6);
  grid(sh, [[['RESPONDED BY', ''], ['DATE', fmt(r.date_answered)]]]);
  sh.text('A response to this RFI is not authorization for a change in contract sum or time. If the response changes cost or schedule, notify the contractor before proceeding.', { size: 7.5, color: GREY });
  footer(sh.pdf, sh.f, `${p.name || ''} ${rfiNumber(r)}`);
  return { bytes: await sh.pdf.save(), filename: `${rfiNumber(r)} ${clean(r.subject || '').slice(0, 40)}.pdf`.replace(/[\\/:*?"<>|]/g, '') };
}

export async function transmittalPdf(subId) {
  const s = get('submittals', subId);
  if (!s) throw Object.assign(new Error('Submittal not found'), { status: 404 });
  const p = get('projects', s.project_id) || {};
  const me = profile();
  const number = `Submittal ${s.number || s.spec_section || ''}`.trim();
  const sh = await startDoc('SUBMITTAL TRANSMITTAL', number);
  grid(sh, [
    [['PROJECT', p.name], ['ADDRESS', [p.address, p.city].filter(Boolean).join(', ')]],
    [['TO (REVIEWER)', [s.reviewer_name, s.reviewer_email].filter(Boolean).join('\n')], ['FROM', `${me.name}, ${me.title}\n${me.company}`]],
    [['SPEC SECTION', s.spec_section], ['SUBMITTAL TYPE', s.kind]],
    [['SUBCONTRACTOR / SUPPLIER', s.supplier], ['DATE TRANSMITTED', fmt(s.date_submitted || today())]],
    [['REVIEW PERIOD', `${s.review_days || 14} calendar days`], ['RETURN REQUESTED BY', fmt(returnDue({ ...s, date_submitted: s.date_submitted || today() }))]],
  ]);
  sh.text(`Item: ${s.title || ''}`, { size: 12, font: sh.f.bold });
  sh.y -= 10;
  section(sh, 'ACTION REQUESTED', '[X] For approval     [ ] For review and comment     [ ] For information only');
  if (s.notes) section(sh, 'NOTES', s.notes);
  if (s.required_onsite) {
    section(sh, 'SCHEDULE NOTE', `Material is required on site by ${fmt(s.required_onsite)}. Lead time after approval is ${s.lead_time_days || 0} days. A timely review keeps this item on schedule.`);
  }
  section(sh, "CONTRACTOR'S REVIEW", `Reviewed by ${me.company} for general conformance with the contract documents and coordination with field conditions. This review does not relieve the subcontractor or supplier of responsibility for dimensions, quantities and compliance with the contract documents.`);
  section(sh, 'ARCHITECT / ENGINEER ACTION', '[ ] No exceptions taken     [ ] Make corrections noted     [ ] Revise and resubmit     [ ] Rejected', 3);
  grid(sh, [[['REVIEWED BY', ''], ['DATE', '']]]);
  footer(sh.pdf, sh.f, `${p.name || ''} ${number}`);
  return { bytes: await sh.pdf.save(), filename: `${number} ${clean(s.title || '').slice(0, 40)} transmittal.pdf`.replace(/[\\/:*?"<>|]/g, '') };
}

// ---------- email drafts ----------
const b64lines = (buf) => Buffer.from(buf).toString('base64').replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const addr = (list) => (list || []).map((a) => (typeof a === 'string' ? a : a.name ? `"${a.name.replace(/"/g, '')}" <${a.email}>` : a.email)).join(', ');

/** Build an unsent .eml that opens as an editable draft in Outlook, with attachments. */
export function buildEml({ to, cc, subject, body, attachments = [] }) {
  const boundary = `nos_${Date.now().toString(36)}`;
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${escapeHtml(body || '').replace(/\n/g, '<br>')}</div>`;
  const parts = [
    'X-Unsent: 1',
    `To: ${encodeHeader(addr(to))}`,
    cc?.length ? `Cc: ${encodeHeader(addr(cc))}` : null,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(Buffer.from(html, 'utf8')),
  ].filter((l) => l !== null);
  for (const a of attachments) {
    const name = encodeHeader(a.filename);
    parts.push(`--${boundary}`, `Content-Type: ${a.contentType || 'application/pdf'}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '', b64lines(a.bytes));
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

export function composeLinks({ to, cc, subject, body }) {
  const emails = (l) => (l || []).map((a) => (typeof a === 'string' ? a : a.email)).filter(Boolean).join(',');
  const q = new URLSearchParams({ to: emails(to), subject: subject || '', body: body || '' });
  if (cc?.length) q.set('cc', emails(cc));
  const mailto = `mailto:${encodeURIComponent(emails(to))}?${new URLSearchParams({ ...(cc?.length ? { cc: emails(cc) } : {}), subject: subject || '', body: body || '' }).toString().replace(/\+/g, '%20')}`;
  return {
    outlookWeb: `https://outlook.office.com/mail/deeplink/compose?${q.toString().replace(/\+/g, '%20')}`,
    mailto,
  };
}

/** Resolve a draft's attachment refs into files. */
export async function draftAttachments(draft) {
  const out = [];
  for (const ref of draft.attachments_json || []) {
    if (ref.type === 'rfi_pdf') {
      const { bytes, filename } = await rfiPdf(ref.id);
      out.push({ filename, bytes, contentType: 'application/pdf' });
    } else if (ref.type === 'transmittal_pdf') {
      const { bytes, filename } = await transmittalPdf(ref.id);
      out.push({ filename, bytes, contentType: 'application/pdf' });
    }
  }
  return out;
}
