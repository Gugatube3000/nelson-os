import { db, get, indexText, newId, now, transaction } from '../db.js';

export function loadChat(chatId, projectId) {
  if (projectId && !get('projects', projectId)) throw Object.assign(new Error('Project not found.'), { status: 404 });
  if (chatId) {
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!row) throw Object.assign(new Error('Conversation not found. Start a new conversation.'), { status: 404 });
    return { ...row, project_id: projectId === undefined ? row.project_id : projectId || null,
      messages: JSON.parse(row.messages_json || '[]'), display: JSON.parse(row.display_json || '[]'), meta: JSON.parse(row.meta_json || '{}') };
  }
  return { id: newId('chat'), title: null, project_id: projectId || null, messages: [], display: [], meta: {}, isNew: true };
}

export function saveChat(chat) {
  transaction(() => {
    const stamp = now();
    db.prepare(`INSERT INTO chats (id, title, project_id, messages_json, display_json, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,
      project_id=excluded.project_id, messages_json=excluded.messages_json, display_json=excluded.display_json,
      meta_json=excluded.meta_json, updated_at=excluded.updated_at`)
      .run(chat.id, chat.title, chat.project_id, JSON.stringify(chat.messages), JSON.stringify(chat.display), JSON.stringify(chat.meta), chat.created_at || stamp, stamp);
    for (let i = 0; i < chat.display.length; i++) {
      const entry = chat.display[i];
      indexText('conversation', `${chat.id}:${i}`, chat.project_id, `${chat.title || 'Conversation'} · ${entry.role}`, entry.text);
    }
  });
  chat.isNew = false;
}

export function transcript(display, maxChars = 60000) {
  const text = display.map((d) => `${d.role === 'user' ? 'User' : 'Nelson OS'}: ${d.text}`).join('\n\n');
  if (text.length <= maxChars) return text;
  return `[Earlier messages remain saved. Use search (kind conversation) and read_conversation to retrieve older details.]\n${text.slice(-maxChars)}`;
}

export function readConversation(chatId, { offset = 0, limit = 20 } = {}) {
  const c = loadChat(chatId);
  const start = Math.max(0, Math.trunc(Number(offset)) || 0);
  const size = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || 20));
  return { id: c.id, title: c.title, project_id: c.project_id, total: c.display.length,
    next_offset: start + size < c.display.length ? start + size : null,
    messages: c.display.slice(start, start + size).map(({ role, text, at }) => ({ role, text, at })) };
}

export function recoverInterruptedChats() {
  const rows = db.prepare('SELECT id FROM chats').all();
  for (const row of rows) {
    const c = loadChat(row.id);
    if (c.meta.pending) {
      c.display.push({ role: 'assistant', text: 'Nelson OS restarted before this answer finished. Your question is saved. Check Activity for any completed changes before asking again.', at: now(), error: true });
      c.meta.pending = false;
      saveChat(c);
    }
  }
}

// Make conversations saved by earlier versions searchable after upgrading.
export function indexSavedConversations() {
  for (const { id } of db.prepare('SELECT id FROM chats').all()) {
    const c = loadChat(id);
    const indexed = db.prepare("SELECT COUNT(*) n FROM search_fts WHERE kind = 'conversation' AND ref_id LIKE ?").get(`${id}:%`).n;
    if (indexed === c.display.length) continue;
    transaction(() => c.display.forEach((entry, i) => indexText('conversation', `${id}:${i}`, c.project_id, `${c.title || 'Conversation'} · ${entry.role}`, entry.text)));
  }
}
