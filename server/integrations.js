// The Connections page: which apps exist, their status, and one-click connect flows.
import Anthropic from '@anthropic-ai/sdk';
import { getSetting, logActivity, setSetting } from './db.js';
import { getSecret, setSecret } from './secrets.js';
import { engineStatus } from './ai/engine.js';
import { cliStatus, installCli, jobs, resolveBin, startLogin, submitLoginCode } from './ai/cli.js';
export { submitLoginCode };
import * as ms from './sync/microsoft.js';
import * as procore from './sync/procore.js';
import { mcpStatus, registerMcp } from '../scripts/lib/system.mjs';

export const CATALOG = [
  { id: 'claude', group: 'ai', name: 'Claude', logo: 'claude.svg', blurb: 'Use your Claude Pro or Max subscription. Reads drawings, drafts RFIs and replies.', kind: 'subscription' },
  { id: 'codex', group: 'ai', name: 'ChatGPT', logo: 'openai.svg', blurb: 'Use your ChatGPT Plus or Pro subscription through Codex.', kind: 'subscription' },
  { id: 'anthropic', group: 'ai', name: 'Claude API key', logo: 'anthropic.svg', blurb: 'Pay-per-use key from console.anthropic.com. Fastest; best for heavy drawing review.', kind: 'key' },
  { id: 'procore', group: 'data', name: 'Procore', logo: 'procore.svg', blurb: 'RFIs, submittals, schedule and project data. Changes in Procore only happen after you approve them.', kind: 'procore' },
  { id: 'outlook', group: 'data', name: 'Outlook', logo: 'outlook.svg', blurb: 'Read-only email and calendar. Nelson OS never sends or deletes mail.', kind: 'oauth' },
  { id: 'onedrive', group: 'data', name: 'OneDrive & SharePoint', logo: 'onedrive.svg', blurb: 'Find drawing sets and specs and add them to a project (read-only).', kind: 'oauth' },
  { id: 'drawings', group: 'data', name: 'Upload drawings', logo: 'folder.svg', blurb: 'Drop PDF drawing sets, specs and takeoffs onto any project.', kind: 'builtin' },
  { id: 'mcp', group: 'use', name: 'Claude Desktop, Claude Code & Codex', logo: 'mcp.svg', blurb: 'Ask about your projects from the Claude or Codex apps too.', kind: 'mcp' },
  { id: 'phone', group: 'use', name: 'Phone at the jobsite', logo: 'phone.svg', blurb: 'Open Nelson OS on your phone with a passcode.', kind: 'builtin' },
  { id: 'googledrive', group: 'later', name: 'Google Drive', logo: 'googledrive.svg', blurb: 'Import drawings from Google Drive.', kind: 'planned' },
  { id: 'dropbox', group: 'later', name: 'Dropbox', logo: 'dropbox.svg', blurb: 'Import drawings from Dropbox.', kind: 'planned' },
  { id: 'quickbooks', group: 'later', name: 'QuickBooks', logo: 'quickbooks.svg', blurb: 'Pull committed costs and invoices into budgets.', kind: 'planned' },
  { id: 'bluebeam', group: 'later', name: 'Bluebeam', logo: 'bluebeam.svg', blurb: 'Bring markups and takeoff quantities in.', kind: 'planned' },
];

const ENGINE_FOR = { claude: 'claude-cli', codex: 'codex-cli', anthropic: 'anthropic' };

export async function connectionStatus() {
  const engine = await engineStatus();
  const m = ms.status();
  const mcp = mcpStatus();
  const phone = getSetting('phone.enabled', false);
  const pc = procore.status();
  const state = {
    claude: { connected: engine.clis.claude.loggedIn, installed: engine.clis.claude.installed, detail: engine.clis.claude.loggedIn ? [engine.clis.claude.account, engine.clis.claude.plan && `${engine.clis.claude.plan} plan`].filter(Boolean).join(' · ') : engine.clis.claude.installed ? 'Installed, not signed in' : null },
    codex: { connected: engine.clis.codex.loggedIn, installed: engine.clis.codex.installed, detail: engine.clis.codex.loggedIn ? engine.clis.codex.method : engine.clis.codex.installed ? 'Installed, not signed in' : null },
    anthropic: { connected: engine.hasKey, detail: engine.hasKey ? `Model ${engine.model}` : null },
    procore: { connected: pc.connected, configured: pc.configured, needsCompany: pc.connected && !pc.company, companies: pc.companies, detail: pc.connected ? [pc.account?.name, pc.company?.name || 'choose a company', pc.env === 'sandbox' && 'sandbox'].filter(Boolean).join(' · ') : pc.configured ? null : 'Needs the one-time Procore app setup', syncing: pc.sync.running, lastSync: pc.lastSync },
    outlook: { connected: m.connected, configured: m.configured, detail: m.connected ? m.account?.email : m.configured ? null : 'Needs the one-time Microsoft app setup' },
    onedrive: { connected: m.connected && m.files, configured: m.configured, detail: m.connected && m.files ? 'Search from any project’s Documents tab' : null },
    drawings: { connected: true, detail: 'Always on' },
    mcp: { connected: mcp.claudeCode || mcp.codex || mcp.claudeDesktop, detail: [mcp.claudeCode && 'Claude Code', mcp.codex && 'Codex', mcp.claudeDesktop && 'Claude Desktop'].filter(Boolean).join(', ') || null },
    phone: { connected: !!phone, detail: phone ? 'On' : null },
  };
  return {
    engine: { engine: engine.engine, label: engine.label, preference: engine.preference },
    apps: CATALOG.map((a) => ({ ...a, ...(state[a.id] || { connected: false }), active: ENGINE_FOR[a.id] === engine.engine })),
  };
}

// Connect Claude or ChatGPT: install the CLI if needed, then open the browser sign-in and wait.
export function connectCli(name) {
  const key = `connect:${name}`;
  if (jobs[key]?.state === 'running') return jobs[key];
  const job = { key, state: 'running', step: 'Checking this computer', url: null, error: null, startedAt: Date.now() };
  jobs[key] = job;
  (async () => {
    try {
      let s = await cliStatus(name);
      if (!s.installed) {
        job.step = name === 'claude' ? 'Installing Claude (about a minute)' : 'Installing Codex (about a minute)';
        const inst = await installCli(name);
        if (inst.state !== 'done') throw new Error(`${inst.error} ${inst.log.slice(-300)}`);
        s = await cliStatus(name);
      }
      if (!s.loggedIn) {
        job.step = 'Waiting for you to sign in (a browser tab opened)';
        const login = startLogin(name);
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          job.url = login.url;
          job.acceptsCode = !!login.acceptsCode;
          if (login.state === 'terminal') job.step = 'Finish signing in in the window that opened';
          s = await cliStatus(name);
          if (s.loggedIn) break;
          if (login.state === 'error') throw new Error('Sign-in did not finish. Click Connect to try again.');
        }
        if (!s.loggedIn) throw new Error('Sign-in timed out. Click Connect to try again.');
      }
      setSetting('ai.engine', ENGINE_FOR[name]);
      await engineStatus({ refresh: true });
      const bin = resolveBin(name, { refresh: true });
      registerMcp(name === 'claude' ? { claudeBin: bin } : { codexBin: bin });
      logActivity({ actor: 'user', kind: 'connect', title: `Connected ${name === 'claude' ? 'Claude' : 'ChatGPT'} as the AI engine`, detail: s.account || s.method || '', why: 'Chosen on the Connections page.' });
      job.state = 'done';
      job.step = 'Connected';
    } catch (err) {
      job.state = 'error';
      job.error = err.message;
    }
  })();
  return job;
}

export async function saveAnthropicKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!/^sk-ant-/.test(key)) throw Object.assign(new Error('That doesn’t look like a Claude API key. It starts with sk-ant-.'), { status: 400 });
  try {
    await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('Anthropic rejected that key. Copy it again from console.anthropic.com.'), { status: 400 });
    throw Object.assign(new Error(`Could not reach Anthropic: ${err.message}`), { status: 502 });
  }
  setSecret('anthropic_api_key', key);
  setSetting('ai.engine', 'anthropic');
  await engineStatus({ refresh: true });
  logActivity({ actor: 'user', kind: 'connect', title: 'Connected a Claude API key', why: 'Entered on the Connections page.' });
}

export async function useEngine(id) {
  setSetting('ai.engine', ENGINE_FOR[id] || 'auto');
  return engineStatus({ refresh: true });
}

export async function disconnect(id) {
  if (id === 'anthropic') setSecret('anthropic_api_key', null);
  if (id === 'outlook' || id === 'onedrive') ms.disconnect();
  if (id === 'procore') procore.disconnect();
  if (id === 'phone') setSetting('phone.enabled', false);
  if (ENGINE_FOR[id] && getSetting('ai.engine') === ENGINE_FOR[id]) setSetting('ai.engine', 'auto');
  logActivity({ actor: 'user', kind: 'disconnect', title: `Disconnected ${CATALOG.find((a) => a.id === id)?.name || id}` });
  return engineStatus({ refresh: true });
}

export function connectMcp() {
  const out = registerMcp({ claudeBin: resolveBin('claude', { refresh: true }), codexBin: resolveBin('codex', { refresh: true }) });
  logActivity({ actor: 'user', kind: 'connect', title: 'Made Nelson OS available in Claude and Codex apps', detail: JSON.stringify(out) });
  return out;
}

export const hasAnthropicKey = () => !!getSecret('anthropic_api_key');
