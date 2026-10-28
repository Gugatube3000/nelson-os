import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

process.env.NELSON_OS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-reliability-'));
const { db, getSetting, setSetting, insert, get, search } = await import('../server/db.js');
const { saveProfile, profile } = await import('../server/ai/prompts.js');
const { loadChat, saveChat, transcript, readConversation, recoverInterruptedChats } = await import('../server/ai/chat-store.js');
const { getSecret, setSecret } = await import('../server/secrets.js');
const { createBackup, BACKUP_DIR, exportData } = await import('../server/backup.js');
const { validateBackup, restoreBackup } = await import('../server/recovery.js');
const ms = await import('../server/sync/microsoft.js');
const { syncCalendar } = await import('../server/sync/mail.js');
const secretModule = pathToFileURL(path.resolve('server/secrets.js')).href;
const dbModule = pathToFileURL(path.resolve('server/db.js')).href;
const child = (code, data = process.env.NELSON_OS_DATA) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NELSON_OS_DATA: data }, timeout: 30000 });

test('partial profile updates preserve onboarding details and a custom signature', () => {
  saveProfile({ name: 'Tester', title: 'Manager', email: 'tester@example.com', phone: '555-0100', signature: 'My custom signature' });
  saveProfile({ title: 'Director' });
  assert.equal(profile().name, 'Tester');
  assert.equal(profile().email, 'tester@example.com');
  assert.equal(profile().phone, '555-0100');
  assert.equal(profile().signature, 'My custom signature');
  assert.equal(profile().title, 'Director');
  assert.throws(() => saveProfile({ name: '' }), /name/);
  assert.equal(profile().name, 'Tester');
});

test('a failed record index rolls back the record instead of leaving half-saved data', () => {
  assert.throws(() => insert('projects', { id: 'bad-project', name: 'Broken index', aliases: '"not an array"' }));
  assert.equal(get('projects', 'bad-project'), undefined);
});

let chatId;
test('conversation history retains early facts beyond six entries and survives a new process', () => {
  const c = loadChat();
  chatId = c.id;
  c.title = 'Persistent memory check';
  c.display = [{ role: 'user', text: 'Remember the elevator codeword marigold.', at: new Date().toISOString() }, ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Later message ${i}` }))];
  saveChat(c);
  assert.match(transcript(c.display), /marigold/);
  assert.equal(readConversation(c.id).messages[0].text, c.display[0].text);
  assert.ok(search('marigold', { kinds: ['conversation'] }).length);
  setSetting('setup.complete', true);
  setSetting('setup.step', 4);
  const out = child(`const {db,getSetting}=await import(${JSON.stringify(dbModule)});if(!getSetting('setup.complete')||getSetting('setup.step')!==4)process.exit(2);const row=db.prepare('SELECT display_json FROM chats WHERE id=?').get(${JSON.stringify(c.id)});if(!row?.display_json.includes('marigold'))process.exit(3);`);
  assert.equal(out.status, 0, out.stderr);
});

test('changing project context is persisted and interrupted questions remain recoverable', () => {
  const project = insert('projects', { name: 'Scope test' });
  const c = loadChat(chatId, project.id);
  c.meta.pending = true;
  c.display.push({ role: 'user', text: 'Question interrupted by a restart' });
  saveChat(c);
  assert.equal(loadChat(chatId).project_id, project.id);
  recoverInterruptedChats();
  const recovered = loadChat(chatId);
  assert.equal(recovered.meta.pending, false);
  assert.match(recovered.display.at(-1).text, /restarted/);
  assert.match(recovered.display.at(-2).text, /Question interrupted/);
  assert.throws(() => loadChat('missing-chat'), /not found/);
});

test('credential writes in another process are visible and are not overwritten by stale memory', () => {
  setSecret('parent', 'value-one');
  assert.equal(getSecret('parent'), 'value-one');
  const out = child(`const {setSecret}=await import(${JSON.stringify(secretModule)});setSecret('child','value-two');`);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(getSecret('child'), 'value-two');
  setSecret('parent', 'value-three');
  assert.equal(getSecret('child'), 'value-two');
});

test('simultaneous credential writers keep every encrypted entry', async () => {
  const jobs = Array.from({ length: 3 }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const {setSecret}=await import(${JSON.stringify(secretModule)});setSecret('parallel-${i}','test-${i}');`], { env: process.env, windowsHide: true, stdio: 'ignore' });
    p.once('error', reject); p.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`)));
  }));
  await Promise.all(jobs);
  for (let i = 0; i < 3; i++) assert.equal(getSecret(`parallel-${i}`), `test-${i}`);
});

test('an unreadable existing Windows key is preserved instead of replaced by a new key', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-bad-key-'));
  fs.writeFileSync(path.join(dir, 'vault.key'), 'invalid-protected-key');
  fs.writeFileSync(path.join(dir, 'vault.enc'), Buffer.alloc(64).toString('base64'));
  const out = child(`const {getSecret}=await import(${JSON.stringify(secretModule)});try{getSecret('x');process.exit(4)}catch(e){if(!e.message.includes('preserved'))process.exit(5)}`, dir);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'vault.key'), 'utf8'), 'invalid-protected-key');
  assert.equal(fs.existsSync(path.join(dir, 'vault.key.plain')), false);
});

test('a failed second calendar page preserves the last complete calendar', async () => {
  setSecret('microsoft_tokens', { access_token: 'test-token', expires_at: Date.now() + 3600000 });
  const at = new Date().toISOString().slice(0, 10) + 'T12:00';
  db.prepare('INSERT INTO calendar_events (id,subject,start) VALUES (?,?,?)').run('saved-event', 'Saved meeting', at);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return Response.json({ value: [{ id: 'new-event', subject: 'New meeting', start: { dateTime: at } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' });
    throw new Error('Network disconnected');
  };
  try { await assert.rejects(syncCalendar(), /Network disconnected/); }
  finally { globalThis.fetch = original; }
  assert.ok(db.prepare('SELECT id FROM calendar_events WHERE id=?').get('saved-event'));
  assert.equal(db.prepare('SELECT id FROM calendar_events WHERE id=?').get('new-event'), undefined);
});

test('parallel Microsoft requests share a single token refresh', async () => {
  setSecret('microsoft_tokens', { access_token: 'old', refresh_token: 'refresh-test', expires_at: 0 });
  const original = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/token')) { refreshes++; await new Promise(r => setTimeout(r, 30)); return Response.json({ access_token: 'new', expires_in: 3600 }); }
    return Response.json({ value: [] });
  };
  try { await Promise.all([ms.graph('/me'), ms.graph('/me/events'), ms.graph('/me/messages')]); }
  finally { globalThis.fetch = original; }
  assert.equal(refreshes, 1);
  assert.equal(getSecret('microsoft_tokens').refresh_token, 'refresh-test');
  await assert.rejects(ms.graph('https://example.com/token-leak'), /another website/);
});

test('admin approval validates state, consumes it once and never reports a declined request as approved', async () => {
  setSetting('microsoft.clientId', '00000000-0000-0000-0000-000000000001');
  const u = new URL(ms.adminConsentUrl());
  assert.match(u.searchParams.get('scope'), /Mail.Read/);
  assert.doesNotMatch(u.searchParams.get('scope'), /\.default|Files|Send|Write/);
  // The admin link is forwarded and often opened after a restart, so an unknown state is
  // allowed. That answer carries no token: it only reports whether the admin accepted.
  assert.deepEqual(await ms.finishAuth({ state: 'opened-later', admin_consent: 'True' }), { returnTo: '/#/connections', adminConsented: true });
  await assert.rejects(ms.finishAuth({ state: 'opened-later', admin_consent: 'True', error: 'access_denied', error_description: 'Administrator declined' }), /declined/);
  await assert.rejects(ms.finishAuth({ state: 'opened-later', admin_consent: 'False' }), /not completed/);
  const state = u.searchParams.get('state');
  await assert.rejects(ms.finishAuth({ state, admin_consent: 'True', error: 'consent_required', error_description: 'Administrator declined' }), /declined/);
  // A normal sign-in still needs a live, unused state.
  await assert.rejects(ms.finishAuth({ state: 'forged', code: 'stolen-code' }), /expired/);
});

test('portable exports include settings, chats and drawing text while excluding sign-in credentials', () => {
  setSetting('phone.passcode', { salt: 'private-salt', hash: 'private-hash' });
  const data = exportData('test');
  assert.ok(data.settings.some(s => s.key === 'setup.complete'));
  assert.ok(data.chats.some(c => c.id === chatId));
  assert.ok(Array.isArray(data.doc_pages));
  assert.ok(!JSON.stringify(data).includes('private-hash'));
  assert.ok(!JSON.stringify(data).includes('refresh-test'));
});

test('a verified full snapshot restores onboarding, conversations, drawings and encrypted sign-ins', async () => {
  const file = path.join(process.env.NELSON_OS_DATA, 'files', 'fixture.pdf');
  fs.writeFileSync(file, '%PDF-test');
  insert('documents', { filename: 'fixture.pdf', path: file, status: 'ready' });
  const saved = await createBackup({ force: true });
  const snapshot = path.join(BACKUP_DIR, saved.latest);
  validateBackup(snapshot);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'nelson-restored-'));
  restoreBackup(snapshot, dest);
  const out = child(`const {getSetting,db}=await import(${JSON.stringify(dbModule)});const {getSecret}=await import(${JSON.stringify(secretModule)});if(!getSetting('setup.complete')||!getSecret('child'))process.exit(2);if(!db.prepare('SELECT display_json FROM chats').all().some(c=>c.display_json.includes('marigold')))process.exit(3);const d=db.prepare('SELECT path FROM documents WHERE filename=?').get('fixture.pdf');if(!d.path.startsWith(${JSON.stringify(dest)}))process.exit(4);`, dest);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(dest, 'files', 'fixture.pdf'), 'utf8'), '%PDF-test');
});
