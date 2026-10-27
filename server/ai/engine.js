// AI engine: Claude API (full agent with tools + drawing vision), or a local
// Claude Code / Codex CLI (text-only answers, no API key needed), or none (rules only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../db.js';
import { CONFIG } from '../paths.js';
import { getSecret } from '../secrets.js';
import { CLAUDE_LOCKDOWN_ENV, cliStatus, codexLockdownArgs, runCli } from './cli.js';

let statusCache = { at: 0, value: null };

/** Sign-in state of the local Claude Code and Codex CLIs (cached for a minute). */
export async function cliStates({ refresh = false } = {}) {
  if (!refresh && statusCache.value && Date.now() - statusCache.at < 60000) return statusCache.value;
  const [claude, codex] = await Promise.all([cliStatus('claude'), cliStatus('codex')]);
  statusCache = { at: Date.now(), value: { claude, codex } };
  return statusCache.value;
}

export function currentModel() {
  return getSetting('ai.model') || CONFIG.ai?.model || 'claude-opus-5-5';
}

export const ENGINE_LABELS = {
  'claude-cli': 'Claude subscription',
  'codex-cli': 'ChatGPT subscription (Codex)',
  anthropic: 'Claude API key',
  none: 'Not connected',
};

export async function engineStatus({ refresh = false } = {}) {
  const preference = getSetting('ai.engine', 'auto');
  const hasKey = !!getSecret('anthropic_api_key');
  const clis = await cliStates({ refresh });
  const available = { anthropic: hasKey, 'claude-cli': clis.claude.loggedIn, 'codex-cli': clis.codex.loggedIn };
  let engine = available[preference] ? preference : null;
  if (!engine) engine = available['claude-cli'] ? 'claude-cli' : available['codex-cli'] ? 'codex-cli' : hasKey ? 'anthropic' : 'none';
  return { engine, label: ENGINE_LABELS[engine], preference, model: currentModel(), hasKey, clis, available };
}

let client = null;
let clientKey = null;
export function anthropic() {
  const key = getSecret('anthropic_api_key');
  if (!key) throw new Error('No Claude API key connected.');
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 3 });
    clientKey = key;
  }
  return client;
}

// One Messages API call with server-side refusal fallback where the model supports it.
export async function createMessage(params) {
  const model = params.model || currentModel();
  const req = { max_tokens: 16000, ...params, model };
  if (/^claude-(opus-5|sonnet-5-5|fable)/.test(model)) {
    req.betas = ['server-side-fallback-2026-07-01'];
    req.fallbacks = 'default';
  }
  const res = await anthropic().beta.messages.create(req);
  if (res.stop_reason === 'refusal') {
    throw new Error('The AI declined this request. Try rephrasing it.');
  }
  return res;
}

export function textOf(res) {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error('AI response was not valid JSON.');
}

async function viaClaudeCli(prompt) {
  const r = await runCli('claude', ['-p', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--no-session-persistence'], { input: prompt, env: CLAUDE_LOCKDOWN_ENV });
  if (r.code !== 0) throw new Error(`Claude Code CLI failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  const out = parseJson(r.stdout);
  if (out.is_error) throw new Error(`Claude Code CLI: ${out.result || 'error'}`);
  return out.result || '';
}

async function viaCodexCli(prompt) {
  const outFile = path.join(os.tmpdir(), `nelson-os-codex-${process.pid}-${Date.now()}.txt`);
  const r = await runCli('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...(await codexLockdownArgs()), '-o', outFile, '-'], { input: prompt });
  try {
    if (r.code !== 0) throw new Error(`Codex CLI failed: ${(r.stderr || r.stdout).slice(-300)}`);
    return fs.readFileSync(outFile, 'utf8');
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * Single-shot completion used for triage, drafting and summaries.
 * documents: [{ block (Anthropic content block), text (plain-text fallback for CLI engines) }]
 */
export async function complete({ system, prompt, schema = null, effort = 'low', documents = [], maxTokens = 16000 }) {
  const { engine } = await engineStatus();
  if (engine === 'none') {
    const err = new Error('No AI connected. Open Connections and connect Claude.');
    err.code = 'NO_AI';
    throw err;
  }
  if (engine === 'anthropic') {
    const content = [...documents.map((d) => d.block).filter(Boolean), { type: 'text', text: prompt }];
    const base = { system, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (!schema) return textOf(await createMessage({ ...base, output_config: { effort } }));
    try {
      const res = await createMessage({ ...base, output_config: { effort, format: { type: 'json_schema', schema } } });
      return parseJson(textOf(res));
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      // Schema rejected by the API: ask for JSON in the prompt instead.
      const res = await createMessage({
        ...base,
        output_config: { effort },
        messages: [{ role: 'user', content: [...content.slice(0, -1), { type: 'text', text: `${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}` }] }],
      });
      return parseJson(textOf(res));
    }
  }
  const docText = documents.map((d) => d.text).filter(Boolean).join('\n\n');
  const full = [
    system,
    docText && `Reference material:\n${docText}`,
    prompt,
    schema && `Return ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(schema)}`,
  ].filter(Boolean).join('\n\n---\n\n');
  const text = engine === 'claude-cli' ? await viaClaudeCli(full) : await viaCodexCli(full);
  return schema ? parseJson(text) : text.trim();
}
