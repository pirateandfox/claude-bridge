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
  repoTrigger:   'button[role="combobox"][aria-label="Add repository"]',  // "Select repo…" on a new session
  repoOption:    '[role="option"]',                                       // repo entries in the open picker
  repoSearch:    'input[placeholder="Search repos…"]',               // type-to-filter input (… is U+2026)
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

  // PR info. The branch row shows a "#N" link to the GitHub PR plus a
  // role="img" status icon ("Open" | "Merged" | "Closed" | "Draft"). (Older
  // markup carried this on a button[aria-label="#N · State"], which is gone — so
  // the previous selector silently reported every PR as "none".)
  let prState = 'none', prNumber = null, prUrl = null;
  const prLink = bar.querySelector('a[href*="/pull/"]');
  if (prLink) {
    prUrl = prLink.getAttribute('href');
    const nm = (prLink.textContent || '').match(/#(\d+)/) || prUrl.match(/\/pull\/(\d+)/);
    if (nm) prNumber = +nm[1];
    const statusLabel = bar.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label')?.trim().toLowerCase();
    prState = statusLabel || 'open';
  }

  // Branch flow renders as [base/repo] → [feature branch]. The feature (working)
  // branch is the button inside .epitaxy-branch-flow (it carries the .truncate);
  // the base/repo is the branch button that precedes the flow. (The flow used to
  // hold both buttons — base at [0], feature at [1] — but now holds only the
  // feature, with the base hoisted out as a sibling. Read both off the full
  // button list, excluding the PR button which is the only one with aria-label.)
  const flowBtn       = bar.querySelector(`${SEL.branchFlow} button`);
  const featureBranch = (flowBtn?.querySelector('.truncate')?.textContent ?? flowBtn?.textContent ?? '').trim() || null;
  const branchBtns    = [...bar.querySelectorAll('button')].filter(b => !b.getAttribute('aria-label'));
  const baseBtn       = branchBtns.find(b => b !== flowBtn);
  const baseBranch    = (baseBtn?.querySelector('.truncate')?.textContent ?? baseBtn?.textContent ?? '').trim() || null;

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

  return { prState, prNumber, prUrl, baseBranch, featureBranch, additions, deletions, ciState };
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

// A brand-new session has no focused row until its first prompt is submitted —
// the only reliable handle is the URL claude.ai navigates to: /code/session_XXX.
function sessionIdFromUrl() {
  const m = location.pathname.match(/\/code\/(session_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Read the branch bar ONLY when we can prove it belongs to `sessionId`.
//
// The bridge drives one shared claude.ai tab, and `.epitaxy-branch-row` is a
// single document-global element in the detail panel. During a route transition
// the OUTGOING session's bar lingers for a few frames (and React may even reuse
// the same DOM node, just patching its text) — so reading the first match blind
// returned a neighbour's branch/PR/diff. This gate is what keys the result to
// the requested session instead of "whatever happens to be on screen".
//
//   navigated   — did we just switch sessions to get here? (false = we were
//                 already parked on this session, so the visible bar is its own)
//   prevBranch  — the featureBranch the bar showed for the session we left
//                 (null if unknown), used to detect that content has switched.
//
// Returns the bar object when fresh, or null while it's still stale/unrendered.
function readBranchBarFresh(sessionId, prevBranch, navigated) {
  // Sidebar focus must be on this session at minimum.
  if (activeSessionId() !== sessionId) return null;

  const bb = readBranchBar();
  if (!bb || !bb.featureBranch) return null;

  // We never left this session — entry already confirmed URL + focus, so the
  // currently-mounted bar is unambiguously this session's.
  if (!navigated) return bb;

  // We navigated here. Accept only once the router has committed to this session
  // (authoritative), OR the bar's content has demonstrably switched away from
  // the session we came from (covers node reuse and a flaky/absent URL signal).
  if (sessionIdFromUrl() === sessionId) return bb;
  if (prevBranch != null && bb.featureBranch !== prevBranch) return bb;
  return null;
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

  // 1. Wait for the focused row to switch (fast, local sidebar update).
  await pollUntil(() => activeSessionId() === sessionId, 4000);

  // 2. Wait for the ROUTER to commit to this session. The URL (/code/session_X)
  //    is the only authoritative signal that the *detail panel* — and therefore
  //    the branch bar / model selector we scrape — now reflects THIS session and
  //    not the one we navigated away from. Sidebar focus can flip a frame before
  //    the route does, so reading on focus alone returned the previous session's
  //    data. (pollUntil returns false rather than throwing if the URL never
  //    commits, so downstream freshness checks can fall back to content change.)
  await pollUntil(() => sessionIdFromUrl() === sessionId, 6000);

  // 3. Wait for the detail panel to actually render (branch bar or chat input).
  //    Bounded by wall-clock so a throttled background tab can't stretch this
  //    past the daemon timeout — see pollUntil.
  await pollUntil(
    () => document.querySelector(SEL.branchBar) || document.querySelector(SEL.chatInput),
    6000,
  );
}

// Click through every session row to force the UI to hydrate branch bars.
// Each click triggers a network fetch; we wait just long enough for focus
// to shift, then move on.  After the sweep we return to the original session.
async function warmAllSessions() {
  const originalId = activeSessionId();
  const rows = document.querySelectorAll(SEL.sessionRow);
  let warmed = 0;

  for (const row of rows) {
    const sid = sessionIdFromKey(row.getAttribute('data-row-key'));
    if (sid === activeSessionId()) { warmed++; continue; } // already loaded

    row.querySelector(SEL.rowMainBtn)?.click();

    // Wait for focus to shift, then let page start loading. Wall-clock bounded
    // so a throttled background tab doesn't stretch the per-session wait.
    await pollUntil(() => activeSessionId() === sid, 2000);
    await sleep(500);
    warmed++;
  }

  // Navigate back to original session (or first one if original is gone)
  if (originalId) {
    const origRow = document.querySelector(`[data-row-key="code:${originalId}"]`);
    if (origRow) {
      origRow.querySelector(SEL.rowMainBtn)?.click();
      await sleep(300);
    }
  }

  return warmed;
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

// Pick a repo in the new-session picker. A code session can no longer be created
// without one — clicking "New session" opens a composer with an empty
// "Select repo…" combobox, and submitting a prompt with no repo is a no-op.
async function selectRepo(repo) {
  const trigger = document.querySelector(SEL.repoTrigger);
  if (!trigger) throw new Error('Repo picker not found — claude.ai UI may have changed');

  trigger.click();
  await pollUntil(() => document.querySelectorAll(SEL.repoOption).length > 0, 3000);

  // Best-effort type-to-filter (the list is long and may virtualize on other
  // accounts). Harmless when all options are already in the DOM.
  const search = document.querySelector(SEL.repoSearch) || document.querySelector('input[type="text"]');
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, repo);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await pollUntil(
      () => [...document.querySelectorAll(SEL.repoOption)].some(o => o.textContent?.trim() === repo),
      2000,
    );
  }

  const norm    = s => (s || '').trim();
  const options = [...document.querySelectorAll(SEL.repoOption)];
  const match   = options.find(o => norm(o.textContent) === repo)
               || options.find(o => norm(o.textContent).toLowerCase() === repo.toLowerCase())
               || options.find(o => norm(o.textContent).endsWith(`/${repo}`));   // allow bare repo name
  if (!match) throw new Error(`Repo "${repo}" not found in picker`);

  match.click();
  // Wait for the picker to close (combobox collapses) before continuing.
  await pollUntil(() => document.querySelector(SEL.repoTrigger)?.getAttribute('aria-expanded') !== 'true', 2000);
}

// Create a new session. Clicking "New session" only opens a blank composer; the
// session itself is created server-side when the first prompt is submitted, and
// its ID then appears in the URL. So the order is: open composer → pick repo →
// set model/effort → submit prompt → read the new ID from the URL.
async function createSession({ model, effort, prompt, repo } = {}) {
  if (!prompt) throw new Error('A prompt is required to create a session');

  let newBtn = null;
  for (const btn of document.querySelectorAll(SEL.rowMainBtn)) {
    if (btn.textContent?.includes('New session')) { newBtn = btn; break; }
  }
  if (!newBtn) throw new Error('New session button not found');

  newBtn.click();
  // Wait for the blank composer to render (URL drops the previous session id).
  await pollUntil(() => document.querySelector(SEL.chatInput), 5000);

  // A repo is now mandatory when the picker is present.
  if (document.querySelector(SEL.repoTrigger)) {
    if (!repo) throw new Error('A repo is required to create a session (e.g. "owner/name")');
    await selectRepo(repo);
  }

  if (model || effort) await setModelEffort(model, effort);

  await injectPrompt(prompt);          // submitting is what actually creates the session

  // The new session id only exists after submit; it lands in the URL.
  await pollUntil(() => sessionIdFromUrl(), 15000);
  return sessionIdFromUrl();
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

// Throttle-immune wait. Resolves true as soon as predicate() is satisfied, or
// false after maxMs.
//
// Why not a setTimeout poll loop: Chrome heavily throttles setTimeout/setInterval
// in BACKGROUND tabs (a 100ms timer can fire at ~1s, or ~1/min when the tab has
// been hidden for minutes). The claude.ai tab is almost always backgrounded when
// the bridge drives it, so timer-based polling ballooned to ~50s and blew the
// daemon's 60s timeout. But DOM mutations caused by network responses / React
// renders are NOT throttled — the branch bar still appears the moment its data
// lands. So we drive the wait off a MutationObserver (fires synchronously on the
// real DOM change) and use timers only as a coarse give-up backstop.
function pollUntil(predicate, maxMs) {
  return new Promise((resolve) => {
    if (predicate()) return resolve(true);
    let done = false;
    const deadline = Date.now() + maxMs;
    let obs, iv, timer;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (obs) obs.disconnect();
      clearInterval(iv);
      clearTimeout(timer);
      resolve(val);
    };
    const check = () => {
      if (predicate()) finish(true);
      else if (Date.now() >= deadline) finish(false);
    };
    obs = new MutationObserver(check);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    iv = setInterval(check, 200);                 // backstop (throttled in bg, harmless)
    timer = setTimeout(() => finish(false), maxMs); // coarse deadline backstop
  });
}

let navLock = Promise.resolve();
function withNavLock(fn) {
  const result = navLock.then(fn);
  navLock = result.catch(() => {});
  return result;
}

// ── Respond via chrome.runtime.sendMessage instead of sendResponse ──────────
// In MV3 the service worker can lose the sendResponse channel during long async
// ops (get_state takes 5-20s of DOM polling).  chrome.runtime.sendMessage
// reliably wakes the worker even if it was terminated mid-operation.
function respond(requestId, data) {
  chrome.runtime.sendMessage({ type: 'cmd_response', requestId, ...data }).catch(() => {});
}

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  const { requestId } = msg;

  (async () => {
    try {
      switch (msg.cmd) {

        case 'list_sessions': {
          const sessions = await readSessions();
          respond(requestId, { ok: true, sessions });
          break;
        }

        case 'warm_sessions': {
          const count = await withNavLock(() => warmAllSessions());
          respond(requestId, { ok: true, warmed: count });
          break;
        }

        case 'get_state': {
          const row = document.querySelector(`[data-row-key="code:${msg.sessionId}"]`);
          if (!row) { respond(requestId, { ok: false, error: 'Session not found' }); break; }

          // EVERYTHING that scrapes session-scoped UI (branch bar, model, effort,
          // usage) must run inside the nav lock and while the tab is confirmed
          // parked on this session. We drive ONE shared claude.ai tab, so a
          // concurrent get_state/inject for another session could navigate the
          // tab away mid-read — which is exactly how branchBar / model / effort /
          // usage previously came back keyed to whatever was last visible rather
          // than to msg.sessionId.
          const scraped = await withNavLock(async () => {
            const onSession = activeSessionId() === msg.sessionId
                           && sessionIdFromUrl() === msg.sessionId;
            const navigated = !onSession;

            // Snapshot the OUTGOING session's branch + usage BEFORE we navigate,
            // so the freshness checks below can tell THIS session's real values
            // from a stale render lingering through the route transition.
            const prevBranch = navigated ? (readBranchBar()?.featureBranch ?? null) : null;
            const prevUsage  = navigated ? readModelEffortUsage().usagePct : null;

            if (navigated) await navigateToSession(msg.sessionId);

            // Block until the detail panel is PROVABLY this session's AND its
            // session-scoped controls have rendered. Everything we scrape
            // (.epitaxy-branch-row plus the model/effort/usage buttons) is
            // document-global, so without this gate we'd return whatever the tab
            // last showed — which is how branchBar AND usagePct previously came
            // back keyed to the wrong session. Wall-clock bounded;
            // MutationObserver-driven so a throttled background tab can't stretch
            // it (see pollUntil).
            let branchBar = null;
            let mev = { model: null, effort: null, usagePct: null };
            await pollUntil(() => {
              const routeConfirmed = sessionIdFromUrl() === msg.sessionId;

              // Branch bar: fresh (proven this session's), or confirmed no-branch
              // (route committed, composer up, no bar element at all).
              branchBar = readBranchBarFresh(msg.sessionId, prevBranch, navigated);
              const branchReady = branchBar
                || (routeConfirmed
                    && document.querySelector(SEL.chatInput)
                    && !document.querySelector(SEL.branchBar));
              if (!branchReady) return false;

              // model/effort/usage live in the same route-keyed panel, but usagePct
              // has no unique per-session token to verify against (two sessions can
              // legitimately read 12%). So: require the route committed (panel is
              // this session's), then accept once the meter is unambiguously this
              // session's — we didn't navigate, or there's no prior value to
              // confuse it with, or the meter moved off the previous session's
              // number, or this session simply has no meter. Otherwise keep waiting
              // (the meter may still be showing the outgoing session's value).
              if (navigated && !routeConfirmed) return false;
              mev = readModelEffortUsage();
              const usageReady = !navigated
                || prevUsage == null
                || mev.usagePct == null
                || mev.usagePct !== prevUsage;
              return usageReady;
            }, 4000);

            return { branchBar, model: mev.model, effort: mev.effort, usagePct: mev.usagePct };
          });

          // prUrl comes straight off the PR link in readBranchBar — no /v1/sessions
          // fetch needed (that had no timeout and could itself hang under the same
          // background-tab conditions).
          respond(requestId, {
            ok: true,
            state: readRowState(row),
            branchBar: scraped.branchBar,
            model:     scraped.model,
            effort:    scraped.effort,
            usagePct:  scraped.usagePct,
          });
          break;
        }

        case 'inject':
          await withNavLock(async () => {
            if (activeSessionId() !== msg.sessionId) await navigateToSession(msg.sessionId);
            await injectPrompt(msg.prompt);
          });
          respond(requestId, { ok: true });
          break;

        case 'create_session': {
          const sessionId = await withNavLock(() => createSession({
            model:  msg.model,
            effort: msg.effort,
            prompt: msg.prompt,
            repo:   msg.repo,
          }));
          respond(requestId, { ok: true, sessionId });
          break;
        }

        case 'archive':
          await withNavLock(() => archiveSession(msg.sessionId));
          respond(requestId, { ok: true });
          break;

        case 'create_pr':
          await withNavLock(() => createPr(msg.sessionId));
          respond(requestId, { ok: true });
          break;

        case 'set_ci_options':
          await withNavLock(() => setCiOptions(msg.sessionId, { autofix: msg.autofix, automerge: msg.automerge }));
          respond(requestId, { ok: true });
          break;

        case 'get_transcript': {
          const turns = await readTranscript(msg.sessionId, msg.lastN);
          respond(requestId, { ok: true, turns });
          break;
        }

        default:
          respond(requestId, { ok: false, error: `Unknown command: ${msg.cmd}` });
      }
    } catch (err) {
      respond(requestId, { ok: false, error: err.message });
    }
  })();

  // Don't return true / don't call sendResponse — chrome.tabs.sendMessage
  // resolves with undefined immediately.  The real result arrives via
  // chrome.runtime.sendMessage → background's onMessage listener.
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

// Nudge the background worker to (re)connect the native host. The MV3 service
// worker can be suspended and lose its native port; when that happens nothing
// reconnects on its own and the bridge goes stuck-disconnected (chrome:false).
// The content script lives with the page, so it can keep poking the worker
// awake. 'content_ready' triggers wake()/ensureConnected() in background.js.
function pokeWake() {
  try { chrome.runtime.sendMessage({ type: 'content_ready', url: location.href }).catch(() => {}); } catch {}
}

pokeWake();
// Periodic heartbeat. setInterval is throttled in a background tab, but even a
// coarse ~1/min tick is enough to recover a dropped connection automatically.
setInterval(pokeWake, 15000);
// Reconnect promptly the moment the tab becomes visible or regains focus.
document.addEventListener('visibilitychange', () => { if (!document.hidden) pokeWake(); });
window.addEventListener('focus', pokeWake);
