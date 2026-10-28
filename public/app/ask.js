import { html, useState, useEffect, useRef, api, useApi, useApp, go, streamChat, toastErr, Markdown, Icon } from './lib.js';

const TAB_FOR = { rfis: 'rfis', submittals: 'submittals', orders: 'procurement', takeoffs: 'procurement', schedule_items: 'schedule', changes: 'budget', permits: 'permits', inspections: 'permits', contacts: 'contacts' };

const STARTERS = [
  'What needs my attention today?',
  'Draft replies for everyone waiting on me',
  'Which orders do I need to release in the next two weeks?',
  'Which RFIs and submittals are late, and what is each one holding up?',
  'Write this week’s owner and investor update',
  'What does Boston require for weekend or after-hours work?',
];

function DidList({ did }) {
  if (!did?.length) return null;
  return html`<div class="did">${did.map((d) => html`<div class="row">
    <span class=${`chip${d.kind === 'draft' ? ' ok' : ''}`}>${d.kind === 'draft' ? 'Draft ready' : d.kind === 'create' ? 'Added' : d.kind === 'update' ? 'Updated' : 'Done'}</span>
    <span class="grow">${d.title}${d.why ? html`<span class="muted small"> — ${d.why}</span>` : null}</span>
    ${d.entity_type === 'drafts' ? html`<a class="btn sm primary" href=${`#/drafts/${d.entity_id}`}>Review and send</a>` : null}
  </div>`)}</div>`;
}

export function Ask({ chatId, query }) {
  const { state } = useApp();
  const { data: chats, reload: reloadChats } = useApi('/chats');
  const [messages, setMessages] = useState([]);
  const [projectId, setProjectId] = useState(query?.project || '');
  const [text, setText] = useState('');
  const [live, setLive] = useState(null);
  const [cid, setCid] = useState(chatId);
  const scroller = useRef();
  const sentQuery = useRef(false);
  const generation = useRef(0);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const token = ++generation.current;
    sending.current = false;
    setLive(null);
    setPending(false);
    setProjectId(query?.project || '');
    setCid(chatId);
    if (!chatId) { setMessages([]); return; }
    api(`/chats/${chatId}`).then((c) => {
      if (token !== generation.current) return;
      setMessages(c.display || []); setProjectId(c.project_id || ''); setPending(c.pending);
    }).catch(toastErr);
  }, [chatId]);
  useEffect(() => {
    if (!pending || !cid) return;
    const token = generation.current;
    const timer = setInterval(() => api(`/chats/${cid}`).then((c) => {
      if (token === generation.current) { setMessages(c.display || []); setPending(c.pending); }
    }).catch(toastErr), 2000);
    return () => clearInterval(timer);
  }, [pending, cid]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [messages, live]);

  const send = async (msg) => {
    const m = (msg ?? text).trim();
    if (!m || sending.current || pending) return;
    sending.current = true;
    const token = generation.current;
    setText('');
    setMessages((xs) => [...xs, { role: 'user', text: m }]);
    setLive({ steps: [] });
    try {
      const out = await streamChat({ chatId: cid, projectId: projectId || null, message: m }, (s) => {
        if (token === generation.current) setLive((l) => ({ steps: [...(l?.steps || []), s.label] }));
      }, (s) => {
        if (token !== generation.current) return;
        setCid(s.chatId); history.replaceState(null, '', `/#/ask/${s.chatId}`); reloadChats();
      });
      if (token === generation.current) setMessages((xs) => [...xs, out.entry]);
      reloadChats();
    } catch (e) {
      if (token === generation.current) setMessages((xs) => [...xs, { role: 'assistant', text: `Something went wrong: ${e.message}` }]);
    } finally { if (token === generation.current) { sending.current = false; setLive(null); } }
  };

  useEffect(() => {
    if (query?.q && !sentQuery.current) { sentQuery.current = true; send(query.q); }
  }, [query?.q]);

  const noAi = state.engine.engine === 'none';
  return html`<div class="page" style="max-width:1300px">
    <div class="page-head"><div><h1>Ask Nelson OS</h1><p class="muted">It reads your email, drawings and logs, prepares drafts and records, and tells you why. Nothing is sent without you.</p></div>
      <button class="btn" onClick=${() => { ++generation.current; sending.current = false; go('#/ask'); setCid(null); setMessages([]); setLive(null); setPending(false); setProjectId(''); }}>${Icon.plus} New conversation</button></div>
    ${noAi && html`<div class="banner"><span class="grow">No AI is connected, so answers are limited to search results.</span><a class="btn sm primary" href="#/connections">Connect Claude or ChatGPT</a></div>`}
    <div class="chat">
      <div class="chat-list">
        <div class="small muted" style="padding:4px 10px 6px">Recent</div>
        ${(chats || []).map((c) => html`<button class=${c.id === cid ? 'on' : ''} onClick=${() => go(`#/ask/${c.id}`)} title=${c.title}>${c.title}</button>`)}
      </div>
      <div class="convo">
        <div class="scroll" ref=${scroller}>
          ${!messages.length && !live ? html`<div style="max-width:640px">
            <h2>What do you need?</h2>
            <p class="muted" style="margin-top:6px">Try one of these, or ask in your own words.</p>
            <div class="prompts">${STARTERS.map((s) => html`<button onClick=${() => send(s)}>${s}</button>`)}</div>
          </div>` : null}
          ${messages.map((m) => (m.role === 'user'
            ? html`<div class="bubble user">${m.text}</div>`
            : html`<div class="bubble ai">
                ${m.steps?.length ? html`<details class="steps"><summary class="small muted" style="cursor:pointer">${m.steps.length} step${m.steps.length === 1 ? '' : 's'}</summary>${m.steps.map((s) => html`<span>${s}</span>`)}</details>` : null}
                <div class="text"><${Markdown} text=${m.text} /></div>
                <${DidList} did=${m.did} />
                ${m.engine && html`<div class="by">${m.engine}</div>`}
              </div>`))}
          ${pending && html`<div class="bubble ai">This conversation is still answering. Your question is saved.</div>`}
          ${live && html`<div class="bubble ai"><div class="steps">${live.steps.map((s) => html`<span>${s}</span>`)}<span class="live">${live.steps.length ? 'Working…' : 'Thinking…'}</span></div></div>`}
        </div>
        <div class="composer">
          <select class="input" style="width:auto;max-width:180px" value=${projectId} onChange=${(e) => setProjectId(e.target.value)} aria-label="Project">
            <option value="">All projects</option>${state.projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
          <textarea class="input" rows="1" placeholder="Ask about a project, an email, a drawing…" value=${text} onInput=${(e) => setText(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
          <button class="btn primary" onClick=${() => send()} disabled=${!!live || pending || !text.trim()} aria-label="Send">${Icon.send}</button>
        </div>
      </div>
    </div>
  </div>`;
}

export { TAB_FOR };
