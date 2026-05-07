// Selectors — single source of truth. Update here when claude.ai changes.
const SEL = {
  sessionRow:    '[data-row-key^="code:"]',
  rowStatus:     '[role="status"]',   // aria-label: "Ready" | "Running"
  rowPrIcon:     '[role="img"]',      // aria-label: "Pull request open/merged/closed"
  rowMainBtn:    '[data-row-main-button]',
  rowAction:     '[data-row-action]',
  branchBar:     '.epitaxy-branch-row',
  branchFlow:    '.epitaxy-branch-flow',
  diffSrOnly:    '.sr-only',
  ciDot:         '.bg-extended-green, .bg-extended-red, .bg-extended-yellow',
  chatInput:     'div[contenteditable="true"][aria-label="Prompt"]',
  sendBtn:       'button[aria-label="Send"]',
  usageBtn:      '[aria-label^="Usage:"]',
};

function sessionIdFromKey(rowKey) {
  return rowKey.replace(/^code:/, '');
}

function readRowState(row) {
  const statusEl = row.querySelector(SEL.rowStatus);
  if (statusEl) {
    const label = statusEl.getAttribute('aria-label') || '';
    if (label === 'Running') return 'running';
    if (label === 'Ready')   return 'ready';
  }
  const prEl = row.querySelector(SEL.rowPrIcon);
  if (prEl) {
    const label = prEl.getAttribute('aria-label') || '';
    if (label.includes('merged')) return 'merged';
    if (label.includes('open'))   return 'pr_open';
    if (label.includes('closed')) return 'pr_closed';
  }
  return 'ready';
}

function readSessionsFromDom() {
  const sessions = [];
  for (const row of document.querySelectorAll(SEL.sessionRow)) {
    const rowKey  = row.getAttribute('data-row-key');
    const mainBtn = row.querySelector(SEL.rowMainBtn);
    const titleEl = mainBtn?.querySelector('.flex-1 .block')
                 ?? mainBtn?.querySelector('.flex-1 span span')
                 ?? mainBtn?.querySelector('.flex-1 span');
    sessions.push({
      sessionId: sessionIdFromKey(rowKey),
      title:     titleEl?.textContent?.trim() ?? '',
      state:     readRowState(row),
      repo:      null,
    });
  }
  return sessions;
}

async function readSessions() {
  try {
    const resp = await fetch('/v1/sessions?limit=100', {
      credentials: 'include',
      headers: {
        'anthropic-beta':    'managed-agents-2026-04-01',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) throw new Error(`Sessions API ${resp.status}`);
    const data = await resp.json();
    console.log('[claude-bridge] sessions API sample:', JSON.stringify(data.data?.[0], null, 2));
    const apiSessions = (data.data ?? []).map(s => ({
      sessionId: s.id,
      title:     s.title ?? '',
      state:     s.session_status ?? 'ready',
      repo:      s.session_context?.outcomes?.[0]?.git_info?.repo ?? null,
    }));
    // If API returns results, use them; otherwise fall through to DOM
    if (apiSessions.length > 0) return apiSessions;
  } catch (e) {
    console.log('[claude-bridge] sessions API failed, using DOM fallback:', e.message);
  }
  return readSessionsFromDom();
}

function readBranchBar() {
  const bar = document.querySelector(SEL.branchBar);
  if (!bar) return null;

  // PR button: aria-label is "PR not yet created" | "#N · Open" | "#N · Merged"
  const prBtn   = bar.querySelector('button[aria-label]');
  const prLabel = prBtn?.getAttribute('aria-label') ?? '';
  let prState = 'none', prNumber = null;
  const m = prLabel.match(/#(\d+) · (.+)/);
  if (m) { prNumber = +m[1]; prState = m[2].toLowerCase(); }

  // Branch names
  const branchBtns    = bar.querySelectorAll(`${SEL.branchFlow} button`);
  const baseBranch    = branchBtns[0]?.textContent?.trim() ?? null;
  const featureBranch = branchBtns[1]?.querySelector('.truncate')?.textContent?.trim() ?? null;

  // Diff stats
  const diffText  = bar.querySelector(SEL.diffSrOnly)?.textContent ?? '';
  const diffMatch = diffText.match(/(\d+) additions?,\s*(\d+) deletions?/);
  const additions = diffMatch ? +diffMatch[1] : 0;
  const deletions = diffMatch ? +diffMatch[2] : 0;

  // CI status from colored dot
  const ciDot  = bar.querySelector(SEL.ciDot);
  const ciState = ciDot
    ? (ciDot.classList.contains('bg-extended-green')  ? 'passing'
    :  ciDot.classList.contains('bg-extended-red')    ? 'failing'
    :                                                    'pending')
    : null;

  return { prState, prNumber, baseBranch, featureBranch, additions, deletions, ciState };
}

function readModelEffortUsage() {
  let model = null, effort = null, usagePct = null;

  // Model button contains a .truncate with model name + a sibling span for effort
  for (const btn of document.querySelectorAll('button')) {
    const truncate = btn.querySelector('.truncate');
    if (!truncate) continue;
    const text = truncate.textContent?.trim() ?? '';
    if (text.includes('Opus') || text.includes('Sonnet') || text.includes('Haiku')) {
      model  = text;
      effort = btn.querySelector('.text-t6')?.textContent?.replace('· ', '').trim() ?? null;
      break;
    }
  }

  const usageBtn = document.querySelector(SEL.usageBtn);
  if (usageBtn) {
    const um = usageBtn.getAttribute('aria-label').match(/(\d+)%/);
    if (um) usagePct = +um[1];
  }

  return { model, effort, usagePct };
}

// Finds the active session's ID via the focused row
function activeSessionId() {
  const focused = document.querySelector('[data-selected="focused"]');
  const row = focused?.closest(SEL.sessionRow);
  return row ? sessionIdFromKey(row.getAttribute('data-row-key')) : null;
}

function findSendButton() {
  // Primary: known aria-label from DOM research
  const known = document.querySelector(SEL.sendBtn);
  if (known) return known;
  // Fallback: search by other labels then positionally
  for (const label of ['Send message', 'Submit']) {
    const btn = document.querySelector(`button[aria-label="${label}"]`);
    if (btn) return btn;
  }
  let el = document.querySelector(SEL.chatInput)?.parentElement;
  for (let i = 0; i < 6 && el; i++) {
    const btns = [...el.querySelectorAll('button:not([disabled])')];
    const submit = btns.findLast(b => b.getAttribute('type') === 'submit');
    if (submit) return submit;
    el = el.parentElement;
  }
  return null;
}

async function navigateToSession(sessionId) {
  const row = document.querySelector(`[data-row-key="code:${sessionId}"]`);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  row.querySelector(SEL.rowMainBtn)?.click();
  // Wait for either branch bar or chat input to appear (up to 3s)
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (document.querySelector(SEL.branchBar) || document.querySelector(SEL.chatInput)) return;
  }
}

async function injectPrompt(text) {
  const input = document.querySelector(SEL.chatInput);
  if (!input) throw new Error('Chat input not found');

  input.focus();

  // Select all content within the input specifically, then replace with insertText
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, text);

  // Wait for React to process the input change, then submit
  await sleep(800);

  // Try Enter key first — most reliable for contenteditable chat inputs
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  await sleep(300);

  // Fallback: full mouse event sequence on the send button
  const send = findSendButton();
  if (!send) throw new Error('Send button not found');
  send.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
  send.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  send.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
}

async function createSession() {
  for (const btn of document.querySelectorAll(SEL.rowMainBtn)) {
    if (btn.textContent?.includes('New session')) {
      btn.click();
      await sleep(1200);
      return activeSessionId();
    }
  }
  throw new Error('New session button not found');
}

async function setModelEffort(model, effort) {
  let modelBtn = null;
  for (const btn of document.querySelectorAll('button')) {
    const t = btn.querySelector('.truncate')?.textContent?.trim() ?? '';
    if (t.includes('Opus') || t.includes('Sonnet') || t.includes('Haiku')) {
      modelBtn = btn; break;
    }
  }
  if (!modelBtn) throw new Error('Model button not found');

  modelBtn.click();
  await sleep(200);

  for (const item of document.querySelectorAll('[role="menuitemradio"]')) {
    const text = item.querySelector('.flex-1')?.textContent?.trim();
    if (model  && text === model)  { item.click(); await sleep(100); }
    if (effort && text === effort) { item.click(); await sleep(100); }
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

async function archiveSession(sessionId) {
  const row = document.querySelector(`[data-row-key="code:${sessionId}"]`);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  row.querySelector(SEL.rowAction)?.click();
  await sleep(200);

  for (const item of document.querySelectorAll('[role="menuitem"]')) {
    const label = item.querySelector('.flex-1')?.textContent?.trim();
    if (label === 'Archive') { item.click(); return; }
  }
  throw new Error('Archive option not found');
}

async function readTranscript(sessionId, lastN) {
  // API uses cse_ prefix; default page order is newest-first
  const cseId = sessionId.replace(/^session_/, 'cse_');
  const turns = [];
  let cursor = null;

  while (true) {
    const params = new URLSearchParams({ limit: 200 });
    if (cursor) params.set('cursor', cursor);

    const resp = await fetch(`/v1/code/sessions/${cseId}/events?${params}`, {
      credentials: 'include',
      headers: {
        'anthropic-beta':    'managed-agents-2026-04-01',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) throw new Error(`Events API ${resp.status}`);
    const data = await resp.json();

    for (const ev of (data.data ?? [])) {
      const turn = parseEvent(ev);
      if (turn) turns.unshift(turn); // newest-first → prepend to get chrono order
    }

    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  if (lastN && lastN > 0) return turns.slice(-lastN);
  return turns;
}

function parseEvent(ev) {
  const ts = ev.created_at ?? null;

  if (ev.event_type === 'user') {
    const content = ev.payload?.message?.content ?? '';
    const text = typeof content === 'string'
      ? content.trim()
      : (Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() : '');
    if (!text) return null;
    return { role: 'user', text, timestamp: ts };
  }

  if (ev.event_type === 'result') {
    const text = (ev.payload?.result ?? '').trim();
    if (!text) return null;
    return { role: 'assistant', text, timestamp: ts };
  }

  return null;
}

async function createPr(sessionId) {
  if (activeSessionId() !== sessionId) await navigateToSession(sessionId);

  const btn = document.querySelector('button[aria-label="Create PR"]');
  if (!btn)           throw new Error('Create PR button not found');
  if (btn.closest('[data-disabled]')) throw new Error('Create PR button is disabled');
  btn.click();
}

async function setCiOptions(sessionId, { autofix, automerge }) {
  if (activeSessionId() !== sessionId) await navigateToSession(sessionId);

  const ciDot = document.querySelector(SEL.ciDot);
  const ciBtn = ciDot?.closest('button');
  if (!ciBtn) throw new Error('CI button not found');

  ciBtn.click();
  await sleep(200);

  for (const cb of document.querySelectorAll('[role="checkbox"]')) {
    const label     = cb.querySelector('.flex-1')?.textContent?.trim() ?? '';
    const isChecked = cb.getAttribute('aria-checked') === 'true';
    if (label.includes('Auto-fix CI')  && autofix    !== undefined && isChecked !== autofix)    cb.click();
    if (label.includes('Auto-merge')   && automerge  !== undefined && isChecked !== automerge)  cb.click();
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let navLock = Promise.resolve();
function withNavLock(fn) {
  const result = navLock.then(fn);
  navLock = result.catch(() => {});
  return result;
}

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.cmd) {

        case 'list_sessions': {
          const sessions = await readSessions();
          sendResponse({ ok: true, sessions });
          break;
        }

        case 'get_state': {
          const row = document.querySelector(`[data-row-key="code:${msg.sessionId}"]`);
          if (!row) { sendResponse({ ok: false, error: 'Session not found' }); break; }

          const { branchBar } = await withNavLock(async () => {
            if (activeSessionId() !== msg.sessionId) {
              await navigateToSession(msg.sessionId);
            }
            return { branchBar: readBranchBar() };
          });

          const state = readRowState(row);

          let prUrl = null;
          if (branchBar?.prNumber) {
            try {
              const sr = await fetch(`/v1/sessions/${msg.sessionId}`, {
                credentials: 'include',
                headers: {
                  'anthropic-beta':    'managed-agents-2026-04-01',
                  'anthropic-version': '2023-06-01',
                },
              });
              if (sr.ok) {
                const sd = await sr.json();
                const repo = sd.session_context?.outcomes?.[0]?.git_info?.repo ?? null;
                if (repo) prUrl = `https://github.com/${repo}/pull/${branchBar.prNumber}`;
              }
            } catch {}
          }

          sendResponse({
            ok: true,
            state,
            branchBar: { ...branchBar, prUrl },
            ...readModelEffortUsage(),
          });
          break;
        }

        case 'inject':
          if (activeSessionId() !== msg.sessionId) await navigateToSession(msg.sessionId);
          await injectPrompt(msg.prompt);
          sendResponse({ ok: true });
          break;

        case 'create_session': {
          const sessionId = await createSession();
          if (msg.model || msg.effort) await setModelEffort(msg.model, msg.effort);
          if (msg.prompt) await injectPrompt(msg.prompt);
          sendResponse({ ok: true, sessionId });
          break;
        }

        case 'archive':
          await archiveSession(msg.sessionId);
          sendResponse({ ok: true });
          break;

        case 'create_pr':
          await createPr(msg.sessionId);
          sendResponse({ ok: true });
          break;

        case 'set_ci_options':
          await setCiOptions(msg.sessionId, { autofix: msg.autofix, automerge: msg.automerge });
          sendResponse({ ok: true });
          break;

        case 'get_transcript': {
          const turns = await readTranscript(msg.sessionId, msg.lastN);
          sendResponse({ ok: true, turns });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown command: ${msg.cmd}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep channel open for async response
});

// ── Proactive state change notifications ───────────────────────────────────────
const lastStates = {};

function checkStateChanges() {
  for (const row of document.querySelectorAll(SEL.sessionRow)) {
    const sessionId = sessionIdFromKey(row.getAttribute('data-row-key'));
    const state     = readRowState(row);
    if (lastStates[sessionId] !== state) {
      lastStates[sessionId] = state;
      try { chrome.runtime.sendMessage({ type: 'state_change', sessionId, state }).catch(() => {}); } catch {}
    }
  }
}

const observer = new MutationObserver(debounce(checkStateChanges, 150));

function startObserver() {
  const sidebar = document.querySelector('[data-row-key^="code:"]')?.closest('nav, aside, [role="navigation"]')
               ?? document.body;
  observer.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'data-kind', 'data-selected'] });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Wait for sidebar to appear before observing
if (document.querySelector(SEL.sessionRow)) {
  startObserver();
} else {
  const boot = new MutationObserver(() => {
    if (document.querySelector(SEL.sessionRow)) { boot.disconnect(); startObserver(); }
  });
  boot.observe(document.body, { childList: true, subtree: true });
}
