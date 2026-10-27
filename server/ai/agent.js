// The conversational agent. Same tools on every engine:
// Claude API runs the tool loop here; Claude Code / Codex run it through the MCP server.
import { db, get, getSetting, newId, now, search, today } from '../db.js';
import { briefingText } from '../domain/briefing.js';
import { createMessage, engineStatus } from './engine.js';
import { agentSystemPrompt } from './prompts.js';
import { runClaudeAgent, runCodexAgent } from './cli-agent.js';
import { TOOLS, executeTool, toolLabel } from './tools.js';

const MAX_TOOL_RESULT = 14000;

function loadChat(chatId, projectId) {
  if (chatId) {
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (row) {
      return { ...row, messages: JSON.parse(row.messages_json || '[]'), display: JSON.parse(row.display_json || '[]'), meta: JSON.parse(row.meta_json || '{}') };
    }
  }
  return { id: newId('chat'), title: null, project_id: projectId || null, messages: [], display: [], meta: {}, isNew: true };
}

function saveChat(chat) {
  const stamp = now();
  if (chat.isNew) {
    db.prepare('INSERT INTO chats (id, title, project_id, messages_json, display_json, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(chat.id, chat.title, chat.project_id, JSON.stringify(chat.messages), JSON.stringify(chat.display), JSON.stringify(chat.meta), stamp, stamp);
    chat.isNew = false;
  } else {
    db.prepare('UPDATE chats SET title = ?, messages_json = ?, display_json = ?, meta_json = ?, updated_at = ? WHERE id = ?')
      .run(chat.title, JSON.stringify(chat.messages), JSON.stringify(chat.display), JSON.stringify(chat.meta), stamp, chat.id);
  }
}

function contextLine(projectId) {
  const p = projectId ? get('projects', projectId) : null;
  return `Today is ${today()}.${p ? ` The user is looking at project "${p.name}" (id ${p.id}).` : ''}`;
}

async function runApiLoop(chat, userText, onStep) {
  chat.messages.push({ role: 'user', content: `${contextLine(chat.project_id)}\n\n${userText}` });
  const system = [{ type: 'text', text: agentSystemPrompt(), cache_control: { type: 'ephemeral' } }];
  for (let turn = 0; turn < 16; turn++) {
    const res = await createMessage({
      system,
      tools: TOOLS,
      messages: chat.messages,
      max_tokens: 16000,
      output_config: { effort: getSetting('ai.effort', 'medium') },
    });
    chat.messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
    const results = await Promise.all(uses.map(async (u) => {
      onStep?.({ tool: u.name, label: toolLabel(u.name) });
      try {
        const out = await executeTool(u.name, u.input);
        let text = JSON.stringify(out);
        if (text.length > MAX_TOOL_RESULT) text = `${text.slice(0, MAX_TOOL_RESULT)}… [truncated; narrow the request]`;
        return { type: 'tool_result', tool_use_id: u.id, content: text };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: u.id, content: err.message, is_error: true };
      }
    }));
    chat.messages.push({ role: 'user', content: results });
  }
  return 'I stopped after many steps without finishing. Try a narrower question.';
}

function transcript(display, n = 6) {
  return display.slice(-n).map((d) => `${d.role === 'user' ? 'User' : 'Nelson OS'}: ${d.text}`).join('\n\n');
}

function noAiAnswer(question, projectId) {
  if (/attention|today|priorit|waiting|overdue|risk|brief/i.test(question)) {
    return `${briefingText()}\n\n(Connect Claude or ChatGPT in Connections for full answers, drafts and drawing reading.)`;
  }
  const hits = search(question, { projectId, limit: 8 });
  if (!hits.length) return 'Nothing in email, drawings or logs matched. Connect Claude or ChatGPT in Connections for full answers.';
  return `Here is what matched (connect Claude or ChatGPT in Connections for full answers):\n${hits.map((h) => `- ${h.kind.replace('_', ' ')}: ${h.title} — ${h.snippet}`).join('\n')}`;
}

/**
 * Run one user turn. onStep receives progress ({label}) for the UI.
 * Returns { chatId, entry } where entry is the assistant's display message.
 */
export async function chat({ chatId, projectId, message, onStep }) {
  const c = loadChat(chatId, projectId);
  if (!c.title) c.title = message.slice(0, 70);
  const startedAt = now();
  const steps = [];
  const step = (s) => { steps.push(s.label); onStep?.(s); };
  const { engine, label } = await engineStatus();
  c.display.push({ role: 'user', text: message, at: startedAt });

  let text;
  try {
    if (engine === 'anthropic') {
      text = await runApiLoop(c, message, step);
    } else if (engine === 'claude-cli') {
      const first = !c.meta.claudeSession;
      const prompt = `${first ? `<instructions>\n${agentSystemPrompt()}\n\nYour tools are the nelson-os MCP tools. Use them; do not use other tools except Read for files you are given.\n</instructions>\n\n` : ''}${contextLine(c.project_id)}\n\n${message}`;
      const out = await runClaudeAgent({ prompt, sessionId: c.meta.claudeSession, onStep: step });
      c.meta.claudeSession = out.sessionId;
      text = out.text;
    } else if (engine === 'codex-cli') {
      const prompt = `<instructions>\n${agentSystemPrompt()}\n\nUse the nelson-os MCP tools to look things up, create records and save drafts. Do not run shell commands or edit files.\n</instructions>\n\n${c.display.length > 1 ? `Conversation so far:\n${transcript(c.display.slice(0, -1))}\n\n` : ''}${contextLine(c.project_id)}\n\nUser: ${message}`;
      text = (await runCodexAgent({ prompt, onStep: step })).text;
    } else {
      text = noAiAnswer(message, c.project_id);
    }
  } catch (err) {
    text = `Something went wrong: ${err.message}`;
  }

  // Everything the agent created or changed during this turn, for the chat card.
  const did = db.prepare(`SELECT kind, title, why, entity_type, entity_id FROM activity_log WHERE actor = 'agent' AND at >= ? ORDER BY id`).all(startedAt);
  const entry = { role: 'assistant', text, at: now(), engine: label, steps, did };
  c.display.push(entry);
  saveChat(c);
  return { chatId: c.id, entry };
}

export function listChats(limit = 30) {
  return db.prepare('SELECT id, title, project_id, updated_at FROM chats ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function getChat(id) {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return row ? { id: row.id, title: row.title, project_id: row.project_id, display: JSON.parse(row.display_json || '[]') } : null;
}
