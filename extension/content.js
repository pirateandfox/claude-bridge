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

// Returns 'unknown' — never 'ready' — when the row carries no readable status.
// An unhydrated row (sidebar virtualised, page still booting, or a selector that
// claude.ai has since renamed) looks identical to an idle one, and this used to
// default to 'ready': "I could not read this" was reported as "this session is
// idle", indistinguishably and with no signal that it had guessed. That is the
// dangerous direction — a caller deciding whether to dispatch work reads the
// guess as a green light and pushes on top of a live session. Callers that need
// certainty should warm first (see warmAllSessions) and re-read; callers that
// cannot tolerate 'unknown' should treat it as busy, not idle.
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
  return 'unknown';
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

// Relay a diagnostic line to the daemon log (/tmp/claude-bridge.log) so the fleet
// is debuggable without opening the headless browser's console — that log is the
// one artifact an operator can actually read on a remote box. Best-effort.
function relayLog(msg) {
  try { chrome.runtime.sendMessage({ type: 'log', msg }); } catch {}
  console.log('[claude-bridge] ' + msg);
}

// fetch() with a hard timeout. claude.ai's in-page API fetches (/v1/sessions,
// /v1/code/sessions/.../events) have NO built-in timeout, so when the tab sits on
// an auth wall or the network stalls, the promise never settles — and the command
// handler awaiting it never responds. That hangs the whole bridge call until the
// daemon's coarse timeout fires, all while passive state_change events keep
// flowing from the (separate) MutationObserver path, masking the stall. An
// AbortController turns that silent hang into a fast, catchable error.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`fetch timed out after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Candidate list endpoints, tried in order. `/v1/sessions` began returning 404
// (observed 2026-08-03) while the per-session endpoints this file already uses
// — `/v1/code/sessions/<id>/events` — kept working, so the collection almost
// certainly moved under the `/v1/code` root alongside them. Probing rather than
// hard-switching means a wrong guess degrades to the next candidate instead of
// silently forcing every caller onto the DOM path, and the relayLog line below
// records which one actually answered so this is diagnosable from the log alone.
// If the 404 candidate is still dead months from now, delete it.
const SESSION_LIST_ENDPOINTS = [
  '/v1/code/sessions?limit=100',
  '/v1/sessions?limit=100',
];

// Archived-session detection. The API field is undocumented and this route has
// already moved once, so check every plausible marker rather than betting on
// one. Deliberately conservative: an unrecognised shape falls through to "not
// archived", which over-reports the open list rather than silently hiding live
// work — the safe direction for a caller deciding what still needs attention.
// Tighten this once the "sessions API fields/status counts" log lines confirm
// the real marker.
function isArchivedSession(s) {
  if (s.archived_at != null || s.archivedAt != null) return true;
  if (s.is_archived === true || s.archived === true) return true;
  // The live API (2026-08-03) exposes `status` and `status_bucket`, not the
  // `session_status` the old code read. Substring-match so a bucket like
  // "archived"/"is_archived" is caught regardless of exact casing or wording.
  for (const v of [s.status, s.status_bucket]) {
    if (String(v ?? '').toLowerCase().includes('archiv')) return true;
  }
  return false;
}

async function readSessions(includeArchived = false) {
  try {
    // On a cold/remote box the very first fetch often times out before the SPA
    // has fully booted. Retry the timeout/network case a couple times with a
    // short backoff so a single cold miss doesn't fall straight to the DOM.
    let resp;
    let usedEndpoint = null;
    for (let attempt = 1; ; attempt++) {
      let lastErr = null;
      for (const endpoint of SESSION_LIST_ENDPOINTS) {
        try {
          const r = await fetchWithTimeout(endpoint, {
            credentials: 'include',
            headers: {
              'anthropic-beta':    'managed-agents-2026-04-01',
              'anthropic-version': '2023-06-01',
            },
          }, 8000);
          // 404 means "not this path" — keep probing. Auth failures and other
          // statuses are about the request, not the route, so stop and let the
          // existing handling below classify them.
          if (r.status === 404) {
            relayLog(`sessions API ${endpoint} → 404; trying next candidate`);
            continue;
          }
          resp = r;
          usedEndpoint = endpoint;
          break;
        } catch (e) {
          lastErr = e;
          // network/timeout on this candidate — try the next before burning a retry
          relayLog(`sessions API ${endpoint} errored (${e.message}); trying next candidate`);
        }
      }
      if (resp) break;
      // Retries exist for the cold-boot timeout case only. If every candidate
      // answered 404 (lastErr still null — no exception was thrown), the routes
      // are simply gone and retrying just burns two more round trips per attempt
      // before the same fallback. Fail straight through to the DOM path.
      if (!lastErr) throw new Error('Sessions API 404 on all candidate endpoints');
      if (attempt >= 3) throw lastErr;
      relayLog(`sessions API attempt ${attempt} exhausted all candidates; retrying`);
      await sleep(750 * attempt);
    }
    // 401/403 means the bridge's Chrome isn't signed in to claude.ai. The DOM
    // fallback is useless here (a logged-out page has no session rows either), so
    // surface an actionable error instead of a silent empty list / hang.
    if (resp.status === 401 || resp.status === 403) throw new Error('NOT_AUTHENTICATED');
    if (!resp.ok) throw new Error(`Sessions API ${resp.status}`);
    const data = await resp.json();
    const rawSessions = data.data ?? [];

    // One-time shape diagnostic. The archived marker is not documented anywhere
    // we control and claude.ai has already moved this route once, so record the
    // available fields and the status distribution rather than trusting
    // isArchivedSession's guesses silently. If the filter ever drops the wrong
    // rows, these two lines say exactly what to key it on instead.
    if (rawSessions.length) {
      relayLog(`sessions API fields: ${Object.keys(rawSessions[0]).join(',')}`);
      // Distribution of every status-shaped field. These are enums, not content,
      // so this is safe to log and it is the only way to learn which one marks a
      // session archived without guessing another round.
      for (const field of ['status', 'status_bucket', 'worker_status', 'connection_status', 'environment_kind']) {
        const counts = {};
        for (const s of rawSessions) {
          const k = String(s[field] ?? '(none)');
          counts[k] = (counts[k] ?? 0) + 1;
        }
        relayLog(`sessions API ${field}: ${JSON.stringify(counts)}`);
      }
    }

    // Normalise back to the `session_` prefix. That is this bridge's canonical
    // external id — the sidebar keys rows `code:session_…`, /code/<id> URLs use
    // it, and every other command resolves a DOM row by it. The API speaks
    // `cse_` (readTranscript converts the other way for the same reason), so
    // returning s.id raw would hand callers ids that get_state, inject and
    // archive all reject with "Session not found".
    const mapSession = s => ({
      sessionId: String(s.id ?? '').replace(/^cse_/, 'session_'),
      title:     s.title ?? '',
      // Surfaced because they are the fields worth triaging on: statusBucket is
      // review_ready|blocked|completed|failed, and workerStatus is the only
      // trustworthy busy/idle signal (the sidebar's aria-label is not — it read
      // "Running" for sessions the API reports idle, one with a merged PR).
      statusBucket: s.status_bucket ?? null,
      workerStatus: s.worker_status ?? null,
      // `session_status` does not exist on this API (confirmed 2026-08-03 — the
      // old code read it and silently got undefined for every row). `status` is
      // the session's own state; `worker_status` describes its container, used
      // only as a fallback.
      state:     s.status ?? s.worker_status ?? 'unknown',
      repo:      s.session_context?.outcomes?.[0]?.git_info?.repo ?? null,
    });

    // Archived sessions are finished work kept only for history — they are gone
    // from the sidebar, and including them turned a 9-row "what is open" list
    // into 46 rows of mostly-closed tickets. Filter by default; callers wanting
    // history pass include_archived.
    const visible = includeArchived ? rawSessions : rawSessions.filter(s => !isArchivedSession(s));
    const hidden  = rawSessions.length - visible.length;
    if (hidden > 0) relayLog(`sessions API filtered ${hidden} archived session(s)`);
    const apiSessions = visible.map(mapSession);
    // An empty API result is ambiguous on a cold/booting page: /v1/sessions can
    // return {data: []} transiently while the SPA's workspace context is still
    // being established (cookies present, sessions not yet indexed). Only trust
    // empty when the DOM agrees — if the sidebar already shows rows, the API
    // answered prematurely, so prefer the DOM rather than reporting a false [].
    // (This keeps commit a553206's intent — a genuinely empty account returns []
    // — while eliminating the false-empty that forced a manual warm on remote.)
    if (apiSessions.length === 0) {
      const domSessions = readSessionsFromDom();
      if (domSessions.length > 0) {
        relayLog(`sessions API empty but DOM has ${domSessions.length}; using DOM (page still booting?)`);
        return domSessions;
      }
    }
    relayLog(`sessions API ok via ${usedEndpoint} — ${apiSessions.length} session(s)`);
    return apiSessions;
  } catch (e) {
    // Auth failure is a real, user-fixable condition — propagate it verbatim so
    // the agent sees "log in", not an empty list. Everything else (timeout,
    // transient network) falls back to scraping the sidebar DOM.
    if (e.message === 'NOT_AUTHENTICATED') {
      throw new Error('Not signed in to claude.ai in the bridge browser. Open https://claude.ai/code in that Chrome profile, log in, then retry.');
    }
    relayLog(`sessions API failed (${e.message}); using DOM fallback`);
    const domSessions = readSessionsFromDom();
    relayLog(`DOM fallback — ${domSessions.length} session(s)`);
    return domSessions;
  }
}

// Authoritative session state, from the API rather than the sidebar DOM.
//
// get_state used to derive `state` from the row's [role="status"] aria-label,
// which is wrong twice over: it is absent for any row the sidebar has not
// rendered (so unwarmed reads fell back to a default), and when present it has
// disagreed with the API outright — reading "Running" for sessions the API
// reports worker_status:idle, including one whose PR had already merged.
//
// Includes archived sessions on purpose: get_state should answer for any id the
// caller holds, not only the ones currently in the sidebar.
async function readSessionMeta(sessionId) {
  try {
    const all = await readSessions(true);
    return all.find(s => s.sessionId === sessionId) ?? null;
  } catch (e) {
    relayLog(`session meta lookup failed for ${sessionId} (${e.message})`);
    return null;
  }
}

// Collapse API metadata into the state vocabulary callers already expect.
// Falls back to the DOM reading only when the API told us nothing, and to
// 'unknown' rather than 'ready' when neither source could answer — an
// unreadable session must never be reported as idle.
function deriveSessionState(meta, domState) {
  if (meta) {
    const worker = String(meta.workerStatus ?? '').toLowerCase();
    if (worker && worker !== 'idle') return 'running';
    if (String(meta.state ?? '').toLowerCase() === 'archived') return 'archived';
    if (worker === 'idle') return 'ready';
  }
  return domState && domState !== 'unknown' ? domState : 'unknown';
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
//   prevSig     — signature of the bar shown for the session we left (null if
//                 unknown), used to detect that content has switched.
//
// Returns the bar object when fresh, or null while it's still stale/unrendered.
function readBranchBarFresh(sessionId, prevSig, navigated) {
  // Sidebar focus must be on this session at minimum.
  if (activeSessionId() !== sessionId) return null;

  const bb = readBranchBar();
  if (!bb || !bb.featureBranch) return null;

  // We never left this session — entry already confirmed URL + focus, so the
  // currently-mounted bar is unambiguously this session's.
  if (!navigated) return bb;

  // We navigated here. The router commits the URL BEFORE React re-renders the
  // detail panel, so a route match is NOT proof the visible bar belongs to this
  // session — accepting on it returned the previously-viewed session's branch,
  // PR and diff under the requested session's id. Require the bar to have
  // demonstrably changed from the one we left.
  //
  // With no previous bar to compare against (we came from a session that had
  // none), the route is the only signal available — fall back to it.
  if (prevSig == null) return sessionIdFromUrl() === sessionId ? bb : null;
  if (branchBarSig(bb) !== prevSig) return bb;
  return null;
}

// Identity signature for a branch bar. Compares more than featureBranch so two
// sessions on similarly-named (or UI-truncated) branches still read as distinct.
function branchBarSig(bb) {
  if (!bb) return null;
  return [bb.featureBranch, bb.baseBranch, bb.prNumber, bb.additions, bb.deletions].join('|');
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

// Returns a commit report — { focused, routed, rendered } — rather than throwing
// when a wait times out.
//
// This is deliberate and load-bearing: `get_state` calls this and then runs its
// OWN freshness gate (readBranchBarFresh, or a confirmed no-branch state), so it
// needs a timed-out navigation to fall through rather than blow up. Callers that
// must NOT act on a half-committed navigation (inject) are responsible for
// checking identity themselves before touching session-scoped UI — see the
// `inject` case. Do not "fix" this by throwing here without auditing get_state.
async function navigateToSession(sessionId) {
  const row = document.querySelector(`[data-row-key="code:${sessionId}"]`);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  row.querySelector(SEL.rowMainBtn)?.click();

  // 1. Wait for the focused row to switch (fast, local sidebar update).
  const focused = await pollUntil(() => activeSessionId() === sessionId, 4000);

  // 2. Wait for the ROUTER to commit to this session. The URL (/code/session_X)
  //    is the only authoritative signal that the *detail panel* — and therefore
  //    the branch bar / model selector we scrape — now reflects THIS session and
  //    not the one we navigated away from. Sidebar focus can flip a frame before
  //    the route does, so reading on focus alone returned the previous session's
  //    data. (pollUntil returns false rather than throwing if the URL never
  //    commits, so downstream freshness checks can fall back to content change.)
  const routed = await pollUntil(() => sessionIdFromUrl() === sessionId, 6000);

  // 3. Wait for the detail panel to actually render (branch bar or chat input).
  //    Bounded by wall-clock so a throttled background tab can't stretch this
  //    past the daemon timeout — see pollUntil.
  //
  //    NOTE: both selectors here are document-global, so this wait can be
  //    satisfied by the OUTGOING session's panel. It is a liveness check ("the
  //    app is rendering something"), NOT proof we arrived. Never treat it as
  //    arrival proof — gate on `routed`/`focused` for that.
  const rendered = await pollUntil(
    () => document.querySelector(SEL.branchBar) || document.querySelector(SEL.chatInput),
    6000,
  );

  return { focused, routed, rendered };
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

// Refuse to act on session-scoped UI unless the shared tab is PROVABLY parked on
// `sessionId` — both the sidebar focus and the committed route must agree.
//
// Why both: sidebar focus flips a frame before the router commits, so focus alone
// says "we're heading there", not "we're there". The route is what determines
// which session the composer posts to.
function assertParkedOn(sessionId, what) {
  const focus = activeSessionId();
  const route = sessionIdFromUrl();
  if (focus === sessionId && route === sessionId) return;

  throw new Error(
    `${what} aborted — shared tab is not on the target session ` +
    `(wanted ${sessionId}, focus=${focus ?? 'none'}, route=${route ?? 'none'})`
  );
}

// `sessionId` is optional: pass it whenever the prompt is meant for an EXISTING
// session and this will refuse to type unless the tab is provably parked there.
// createSession omits it — a session that doesn't exist yet has no id to check.
async function injectPrompt(text, { sessionId } = {}) {
  if (sessionId) assertParkedOn(sessionId, 'injectPrompt');

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

    const resp = await fetchWithTimeout(`/v1/code/sessions/${cseId}/events?${params}`, {
      credentials: 'include',
      headers: {
        'anthropic-beta':    'managed-agents-2026-04-01',
        'anthropic-version': '2023-06-01',
      },
    }, 10000);
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

// Newest user turn for `sessionId`, read straight off the session-keyed events
// API. DOM-INDEPENDENT ON PURPOSE: this is the channel used to PROVE that an
// injected prompt landed in the session we asked for, so it must not be able to
// observe "whatever the shared claude.ai tab happens to be showing". The
// sessionId is in the URL path, so the answer is keyed to the session by
// construction.
async function sessionEventHead(sessionId, timeoutMs = 5000) {
  const cseId = sessionId.replace(/^session_/, 'cse_');
  const resp = await fetchWithTimeout(`/v1/code/sessions/${cseId}/events?limit=20`, {
    credentials: 'include',
    headers: {
      'anthropic-beta':    'managed-agents-2026-04-01',
      'anthropic-version': '2023-06-01',
    },
  }, timeoutMs);
  if (!resp.ok) throw new Error(`Events API ${resp.status}`);
  const data = await resp.json();

  // Default page order is newest-first — first user event is the latest one.
  for (const ev of (data.data ?? [])) {
    if (ev.event_type !== 'user') continue;
    const turn = parseEvent(ev);
    if (turn) return { id: ev.id ?? null, text: turn.text, timestamp: turn.timestamp };
  }
  return null;
}

const normText = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// Hard wall-clock budget for delivery confirmation.
//
// This MUST leave room under the daemon's 60s `inject` timeout, because a daemon
// timeout is the one outcome worse than "unverified": it surfaces as an error for
// a prompt that actually landed, which invites the retry that double-posts. Worst
// case for the whole inject path is navigateToSession (~16s) + injectPrompt (~1s)
// + baseline head (5s) + this budget — comfortably inside 60s.
//
// Bounded by Date.now(), not by attempt count, because these are raw `sleep()`
// calls and Chrome throttles timers hard in background tabs — which is where the
// bridge's tab always is (see pollUntil's note). An attempt-counted loop looks
// like 6s on paper and can take far longer in a hidden tab.
const CONFIRM_BUDGET_MS = 15_000;

// Confirm the prompt actually became a NEW user turn in THIS session, and hand
// back a turn id the caller can re-verify against get_transcript.
//
// Reports rather than throws: an unconfirmed result returns verified:false and
// lets the caller check the transcript, instead of raising an error that invites
// a blind — and possibly duplicating — retry.
async function confirmInjected(sessionId, prompt, before) {
  // No baseline means we cannot distinguish a new turn from one already present.
  // That matters most on a RETRY of a prompt that already landed: the newest turn
  // is then our own text from the previous attempt, so a failed injection would
  // read as verified. Report unverifiable rather than guessing.
  if (!before) {
    return { verified: false, turnId: null, turnTimestamp: null, reason: 'no-baseline' };
  }

  const wanted   = normText(prompt).slice(0, 80);
  const deadline = Date.now() + CONFIRM_BUDGET_MS;

  while (Date.now() < deadline) {
    await sleep(750);
    if (Date.now() >= deadline) break;

    let head;
    try { head = await sessionEventHead(sessionId, 4000); }
    catch { continue; }               // transient API blip — keep waiting
    if (!head) continue;

    const isNew = (head.id && before.id && head.id !== before.id)
               || head.timestamp !== before.timestamp;

    if (isNew && (!wanted || normText(head.text).includes(wanted))) {
      // The events API does not expose a stable per-event id today, so fall back
      // to the turn's timestamp — which IS checkable, because get_transcript
      // returns `timestamp` on every turn. Keep the id preference first in case
      // the API grows one.
      return {
        verified: true,
        turnId: head.id ?? head.timestamp ?? null,
        turnTimestamp: head.timestamp,
      };
    }
  }

  return {
    verified: false,
    turnId: null,
    turnTimestamp: null,
    reason: 'unconfirmed-within-budget',
  };
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

  // Same misroute class as inject (2026-07-29): the button below is
  // document-global, so a silently-failed navigation would open a PR on
  // whichever session the shared tab is still showing.
  assertParkedOn(sessionId, 'create_pr');

  const btn = document.querySelector('button[aria-label="Create PR"]');
  if (!btn)           throw new Error('Create PR button not found');
  if (btn.closest('[data-disabled]')) throw new Error('Create PR button is disabled');
  btn.click();
}

async function setCiOptions(sessionId, { autofix, automerge }) {
  if (activeSessionId() !== sessionId) await navigateToSession(sessionId);

  // Global CI button + global checkboxes — same gate as create_pr, or auto-merge
  // gets flipped on someone else's session.
  assertParkedOn(sessionId, 'set_ci_options');

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
          // The DOM fallback inside readSessions needs no filtering — the
          // sidebar only renders non-archived rows in the first place.
          const sessions = await readSessions(msg.includeArchived === true);
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
          if (!row) {
            // Archived sessions are not rendered in the sidebar at all, so there
            // is no row to click and the UI-scraped fields are unreachable — but
            // the API still knows the session. Answer with metadata and return
            // the scraped fields as null rather than failing the whole call, so
            // "this id is archived" is distinguishable from "this id is bogus".
            const meta = await readSessionMeta(msg.sessionId);
            if (!meta) { respond(requestId, { ok: false, error: 'Session not found' }); break; }
            relayLog(`get_state ${msg.sessionId}: no sidebar row (archived?) — metadata only (worker=${meta.workerStatus ?? 'n/a'} bucket=${meta.statusBucket ?? 'n/a'})`);
            respond(requestId, {
              ok: true,
              state:        deriveSessionState(meta, 'unknown'),
              statusBucket: meta.statusBucket ?? null,
              workerStatus: meta.workerStatus ?? null,
              branchBar: null,
              model:     null,
              effort:    null,
              usagePct:  null,
            });
            break;
          }

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

            // Snapshot the OUTGOING session's bar BEFORE we navigate, so the
            // freshness check can tell THIS session's branch bar from a stale one
            // lingering through the route transition.
            const prevSig = navigated ? branchBarSig(readBranchBar()) : null;

            if (navigated) await navigateToSession(msg.sessionId);

            // Block until the detail panel is PROVABLY this session's: a branch
            // bar that's fresh (readBranchBarFresh) or a confirmed no-branch state
            // (route committed, composer up, no bar element). .epitaxy-branch-row
            // is document-global, so without this gate we'd return whatever the tab
            // last showed — that's how branchBar previously came back keyed to the
            // wrong session. Wall-clock bounded; MutationObserver-driven so a
            // throttled background tab can't stretch it (see pollUntil).
            let branchBar = null;
            await pollUntil(() => {
              const routeConfirmed = sessionIdFromUrl() === msg.sessionId;
              branchBar = readBranchBarFresh(msg.sessionId, prevSig, navigated);
              return branchBar
                || (routeConfirmed
                    && document.querySelector(SEL.chatInput)
                    && !document.querySelector(SEL.branchBar));
            }, 4000);

            // Now read model/effort/usage — inside the lock, panel confirmed on
            // this session. model/effort are per-session (the composer's selector)
            // and rendered with the panel we just gated on. usagePct is NOT
            // per-session: it's the global account meter ("Usage: plan N%") in the
            // app chrome, identical for every session — so it needs no per-session
            // gating (an earlier attempt to "wait until it changes" wrongly forced
            // a timeout, since a global value never changes between sessions).
            const mev = readModelEffortUsage();
            return { branchBar, model: mev.model, effort: mev.effort, usagePct: mev.usagePct };
          });

          // prUrl comes straight off the PR link in readBranchBar — no /v1/sessions
          // fetch needed (that had no timeout and could itself hang under the same
          // background-tab conditions).
          // State comes from the API, not the row — see readSessionMeta. The DOM
          // reading is kept only as a fallback for when the API cannot answer.
          const gsMeta  = await readSessionMeta(msg.sessionId);
          const gsState = deriveSessionState(gsMeta, readRowState(row));
          relayLog(`get_state ${msg.sessionId}: state=${gsState} (worker=${gsMeta?.workerStatus ?? 'n/a'} bucket=${gsMeta?.statusBucket ?? 'n/a'}) branch=${scraped.branchBar?.featureBranch ?? 'none'} usagePct=${scraped.usagePct ?? 'n/a'}`);
          respond(requestId, {
            ok: true,
            state: gsState,
            statusBucket: gsMeta?.statusBucket ?? null,
            workerStatus: gsMeta?.workerStatus ?? null,
            branchBar: scraped.branchBar,
            model:     scraped.model,
            effort:    scraped.effort,
            usagePct:  scraped.usagePct,
          });
          break;
        }

        case 'inject': {
          // Misroute incident 2026-07-29 ~19:30Z: a prompt intended for one
          // session was posted into another, and the daemon still answered
          // `injected: true`. Cause was check-then-act here — `navigateToSession`
          // reports instead of throwing, and its render wait is satisfied by
          // SEL.chatInput, which is document-global and therefore already matched
          // by the OUTGOING session's composer. So a silently-failed navigation
          // fell straight through to injectPrompt and typed into whatever session
          // was still mounted. `readBranchBarFresh` had this identity discipline
          // since the get_state fix; inject never got it.
          const delivery = await withNavLock(async () => {
            if (activeSessionId() !== msg.sessionId) await navigateToSession(msg.sessionId);

            // Hard gate — never type blind. Cheap, and the whole defence.
            assertParkedOn(msg.sessionId, 'inject');

            // Baseline for proof-of-delivery, from the session-keyed events API
            // rather than the DOM (see sessionEventHead). Best-effort: if the API
            // is unavailable we still inject, we just report verified:false —
            // confirmInjected refuses to guess without a baseline.
            let before = null;
            try { before = await sessionEventHead(msg.sessionId, 5000); } catch {}

            await injectPrompt(msg.prompt, { sessionId: msg.sessionId });

            // Re-check identity AFTER submitting: if a concurrent request moved
            // the tab mid-submit, say so rather than reporting a clean success.
            const stillParked = activeSessionId() === msg.sessionId
                             && sessionIdFromUrl() === msg.sessionId;

            const confirmation = await confirmInjected(msg.sessionId, msg.prompt, before);
            return { ...confirmation, stillParked };
          });

          relayLog(
            `inject ${msg.sessionId}: verified=${delivery.verified} ` +
            `turnId=${delivery.turnId ?? 'none'} stillParked=${delivery.stillParked}` +
            (delivery.reason ? ` reason=${delivery.reason}` : '')
          );
          respond(requestId, { ok: true, ...delivery });
          break;
        }

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
    // An unreadable row is not a transition. Skip without recording, so the
    // genuine state still emits once the row hydrates rather than being
    // swallowed as "already seen".
    if (state === 'unknown') continue;
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
