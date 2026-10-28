// Outlook sync (read-only): pull mail from the inbox and sent items, group conversations,
// triage them, and pull the next three weeks of calendar events.
import { db, getSetting, indexText, logActivity, now, setSetting, transaction } from '../db.js';
import { projectInText } from '../domain/projects.js';
import { CONFIG } from '../paths.js';
import { stripQuoted } from '../ai/tools.js';
import { graph, pages, status as msStatus } from './microsoft.js';
import { triagePending } from './triage.js';

export const syncState = { running: false, phase: 'idle', fetched: 0, conversations: 0, done: 0, total: 0, error: null, startedAt: null, finishedAt: null };

const SELECT = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,webLink,importance';
const people = (list) => (list || []).map((r) => ({ name: r.emailAddress?.name || null, email: (r.emailAddress?.address || '').toLowerCase() }));
const cleanSubject = (s) => String(s || '(no subject)').replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').trim() || '(no subject)';

function upsertEmail(m, folder, me) {
  const from = m.from?.emailAddress || {};
  const fromEmail = (from.address || '').toLowerCase();
  const fromMe = folder === 'sentitems' || (!!me && fromEmail === me) ? 1 : 0;
  const body = String(m.body?.content || m.bodyPreview || '').slice(0, 30000);
  const at = m.receivedDateTime || m.sentDateTime;
  db.prepare(`INSERT INTO emails (id, thread_id, folder, subject, from_name, from_email, to_json, cc_json, received_at, from_me, body_text, preview, has_attachments, web_link, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, body_text = excluded.body_text, preview = excluded.preview, web_link = excluded.web_link`)
    .run(m.id, m.conversationId, folder, m.subject || '', from.name || null, fromEmail, JSON.stringify(people(m.toRecipients)), JSON.stringify(people(m.ccRecipients)),
      at, fromMe, body, (m.bodyPreview || '').slice(0, 300), m.hasAttachments ? 1 : 0, m.webLink || null, m.importance || null, now());
  const pid = db.prepare('SELECT project_id FROM emails WHERE id = ?').get(m.id)?.project_id;
  indexText('email', m.id, pid, `${m.subject || ''} ${from.name || ''}`, stripQuoted(body).slice(0, 8000));
}

export function rebuildThread(conversationId) {
  const emails = db.prepare('SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at').all(conversationId);
  if (!emails.length) return;
  const last = emails[emails.length - 1];
  const who = new Map();
  for (const e of emails) {
    if (e.from_email) who.set(e.from_email, e.from_name || e.from_email);
    for (const r of JSON.parse(e.to_json || '[]')) if (r.email) who.set(r.email, r.name || r.email);
  }
  const existing = db.prepare('SELECT id, last_at, status FROM threads WHERE id = ?').get(conversationId);
  // A new message reopens a thread that was marked done.
  if (existing?.status === 'done' && last.received_at > existing.last_at) {
    db.prepare("UPDATE threads SET status = 'open' WHERE id = ?").run(conversationId);
  }
  const fields = {
    subject: cleanSubject(emails[0].subject),
    last_at: last.received_at,
    last_from_me: last.from_me,
    message_count: emails.length,
    participants_json: JSON.stringify([...who].map(([email, name]) => ({ email, name }))),
    updated_at: now(),
  };
  if (existing) {
    db.prepare('UPDATE threads SET subject = ?, last_at = ?, last_from_me = ?, message_count = ?, participants_json = ?, updated_at = ? WHERE id = ?')
      .run(...Object.values(fields), conversationId);
  } else {
    db.prepare('INSERT INTO threads (id, subject, last_at, last_from_me, message_count, participants_json, updated_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(conversationId, ...Object.values(fields), now(), 'open');
  }
}

export async function syncCalendar() {
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 21 * 86400000).toISOString();
  const headers = { Prefer: 'outlook.timezone="Eastern Standard Time"' };
  const events = [];
  for await (const batch of pages(`/me/calendarView?startDateTime=${start}&endDateTime=${end}&$select=id,subject,start,end,location,organizer,webLink&$orderby=start/dateTime&$top=100`, { headers })) {
    events.push(...batch);
  }
  transaction(() => {
    db.prepare("DELETE FROM calendar_events WHERE start >= ? AND start <= ? AND id NOT LIKE 'demo-%'").run(start.slice(0, 10), `${end.slice(0, 10)}T23:59`);
    for (const e of events) {
      const p = projectInText(`${e.subject} ${e.location?.displayName || ''}`);
      db.prepare(`INSERT OR REPLACE INTO calendar_events (id, subject, start, end, location, organizer, project_id, web_link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, e.subject, e.start?.dateTime?.slice(0, 16), e.end?.dateTime?.slice(0, 16), e.location?.displayName || null, e.organizer?.emailAddress?.name || null, p?.id || null, e.webLink || null, now(), now());
    }
  });
}

async function folderIds() {
  const ids = {};
  for (const name of ['deleteditems', 'junkemail', 'drafts', 'outbox', 'conversationhistory', 'syncissues', 'sentitems']) {
    try { ids[name] = (await graph(`/me/mailFolders/${name}?$select=id`)).id; } catch { /* folder not present */ }
  }
  const { sentitems: sent, ...rest } = ids;
  return { sent, skip: new Set(Object.values(rest).filter(Boolean)) };
}

/** Sync Outlook. The first run reads the last `days` (default 30); later runs read what is new. */
export async function syncMail({ days } = {}) {
  if (syncState.running) return syncState;
  if (!msStatus().connected) throw Object.assign(new Error('Outlook is not connected.'), { status: 400 });
  Object.assign(syncState, { running: true, phase: 'Connecting to Outlook', fetched: 0, conversations: 0, done: 0, total: 0, error: null, startedAt: now(), finishedAt: null });
  const firstRun = !getSetting('mail.lastSync');
  try {
    const last = getSetting('mail.lastSync');
    const window = days || CONFIG.sync?.initialDays || 30;
    const since = new Date(!last || days ? Date.now() - window * 86400000 : new Date(last).getTime() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
    const me = (getSetting('microsoft.account')?.email || '').toLowerCase();
    const touched = new Set();
    const headers = { Prefer: 'outlook.body-content-type="text"' };
    const take = (m, folder) => {
      upsertEmail(m, folder, me);
      if (m.conversationId) touched.add(m.conversationId);
      syncState.fetched++;
    };
    try {
      // Every folder, including project folders that Outlook rules file mail into and the
      // archive; Deleted Items, Junk, Drafts and Outbox are skipped.
      const { skip, sent } = await folderIds();
      syncState.phase = 'Reading your mail';
      for await (const batch of pages(`/me/messages?$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=50&$select=${SELECT},parentFolderId`, { headers })) {
        for (const m of batch) if (!skip.has(m.parentFolderId)) take(m, m.parentFolderId === sent ? 'sentitems' : 'mail');
      }
    } catch (err) {
      if (err.code === 'SEND_BLOCKED' || err.code === 'NOT_CONNECTED') throw err;
      console.warn('[sync] all-folder read failed, reading Inbox and Sent Items:', err.message);
      for (const [folder, field, label] of [['inbox', 'receivedDateTime', 'Reading your inbox'], ['sentitems', 'sentDateTime', 'Reading your sent mail']]) {
        syncState.phase = label;
        for await (const batch of pages(`/me/mailFolders/${folder}/messages?$filter=${field} ge ${since}&$orderby=${field} desc&$top=50&$select=${SELECT}`, { headers })) {
          for (const m of batch) take(m, folder);
        }
      }
    }
    syncState.phase = 'Grouping conversations';
    for (const id of touched) rebuildThread(id);
    syncState.conversations = touched.size;

    syncState.phase = 'Understanding conversations';
    const result = await triagePending({ progress: (done, total) => Object.assign(syncState, { done, total }) });

    syncState.phase = 'Reading your calendar';
    try { await syncCalendar(); } catch (err) { console.warn('[sync] calendar skipped:', err.message); }

    setSetting('mail.lastSync', syncState.startedAt);
    if (firstRun || syncState.fetched) {
      logActivity({
        actor: 'system',
        kind: 'sync',
        title: `Read ${syncState.fetched} emails in ${touched.size} conversations from Outlook`,
        detail: result.ai ? `Understood ${result.triaged} work conversations with AI${result.failures ? ` (${result.failures} batches kept the quick rules result)` : ''}.` : 'Sorted with quick rules. Connect Claude or ChatGPT for deeper understanding.',
        why: firstRun ? `First import: the last ${window} days, read-only.` : 'Scheduled sync.',
      });
    }
  } catch (err) {
    syncState.error = err.message;
    console.warn('[sync] failed:', err.message);
  } finally {
    syncState.running = false;
    syncState.phase = syncState.error ? 'error' : 'done';
    syncState.finishedAt = now();
  }
  return syncState;
}

export { graph };
