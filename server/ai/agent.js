// The conversational agent. Same tools on every engine:
// Claude API runs the tool loop here; Claude Code / Codex run it through the MCP server.
import { db, get, getSetting, newId, now, search, today } from '../db.js';
import { briefingText } from '../domain/briefing.js';
import { createMessage, engineStatus } from './engine.js';
import { agentSystemPrompt } from './prompts.js';
import { runClaudeAgent, runCodexAgent } from './cli-agent.js';
import { TOOLS, executeTool, toolLabel } from './tools.js';
import { loadChat, saveChat, transcript } from './chat-store.js';

const MAX_TOOL_RESULT = 14000;

const activeChats = new Set();

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
export async function chat({ chatId, projectId, message, onStep, onStarted }) {
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('Enter a question first.'), { status: 400 });
  const c = loadChat(chatId, projectId);
  if (activeChats.has(c.id)) throw Object.assign(new Error('This conversation is still answering. Wait for it to finish.'), { status: 409 });
  activeChats.add(c.id);
  try {
  if (!c.title) c.title = message.slice(0, 70);
  const startedAt = now();
  const steps = [];
  const step = (s) => { steps.push(s.label); onStep?.(s); };
  c.display.push({ role: 'user', text: message, at: startedAt });
  c.meta.pending = true;
  saveChat(c);
  onStarted?.({ chatId: c.id });

  let text;
  let label = 'Nelson OS';
  let failed = false;
  const savedMessages = structuredClone(c.messages);
  try {
    const status = await engineStatus();
    const { engine } = status;
    label = status.label;
    if (engine === 'anthropic') {
      if (c.meta.lastEngine !== 'anthropic') c.messages = [];
      text = await runApiLoop(c, c.messages.length ? message : `${transcript(c.display.slice(0, -1))}\n\n${message}`, step);
    } else if (engine === 'claude-cli') {
      const first = !c.meta.claudeSession;
      const instructions = `<instructions>\n${agentSystemPrompt()}\n\nYour tools are the nelson-os MCP tools. Use them; do not use other tools except Read for files you are given.\n</instructions>\n\n`;
      const fallbackPrompt = `${instructions}Saved conversation:\n${transcript(c.display.slice(0, -1))}\n\n${contextLine(c.project_id)}\n\n${message}`;
      const prompt = first ? fallbackPrompt : `${instructions}${contextLine(c.project_id)}\n\n${message}`;
      const out = await runClaudeAgent({ prompt, fallbackPrompt, sessionId: c.meta.claudeSession, onStep: step });
      c.meta.claudeSession = out.sessionId;
      text = out.text;
    } else if (engine === 'codex-cli') {
      const prompt = `<instructions>\n${agentSystemPrompt()}\n\nUse the nelson-os MCP tools to look things up, create records and save drafts. Do not run shell commands or edit files.\n</instructions>\n\n${c.display.length > 1 ? `Conversation so far:\n${transcript(c.display.slice(0, -1))}\n\n` : ''}${contextLine(c.project_id)}\n\nUser: ${message}`;
      text = (await runCodexAgent({ prompt, onStep: step })).text;
    } else {
      text = noAiAnswer(message, c.project_id);
    }
    c.meta.lastEngine = engine;
  } catch (err) {
    text = `Something went wrong: ${err.message}`;
    failed = true;
    c.messages = savedMessages;
  }

  // Everything the agent created or changed during this turn, for the chat card.
  const did = db.prepare(`SELECT kind, title, why, entity_type, entity_id FROM activity_log WHERE actor = 'agent' AND at >= ? ORDER BY id`).all(startedAt);
  const entry = { role: 'assistant', text, at: now(), engine: label, steps, did, error: failed };
  c.display.push(entry);
  c.meta.pending = false;
  saveChat(c);
  return { chatId: c.id, entry };
  } finally { activeChats.delete(c.id); }
}

export function listChats(limit = 30) {
  return db.prepare('SELECT id, title, project_id, updated_at FROM chats ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function getChat(id) {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return row ? { id: row.id, title: row.title, project_id: row.project_id, display: JSON.parse(row.display_json || '[]'), pending: activeChats.has(id) } : null;
}
