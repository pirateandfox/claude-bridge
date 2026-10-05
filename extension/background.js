const HOST_NAME = 'com.claudebridge.host';
const KEEPALIVE_ALARM = 'claude-bridge-keepalive';
const RECONNECT_ALARM = 'claude-bridge-reconnect';
const RECONNECT_DELAY_MS = 2000;

// A port is only proof of a live relay if something answers on it. The keepalive
// tick pings the daemon; if nothing has answered in more than two ticks, the port
// is wedged rather than idle and gets torn down. Two ticks so a single missed or
// throttled alarm cannot cause a spurious reconnect.
const PONG_GRACE_MS = 150_000;

let port = null;
let reconnectTimer = null;
let lastPongAt = 0;

function isClaudeUrl(url) {
  return typeof url === 'string' && url.startsWith('https://claude.ai/');
}

// Mirror a diagnostic line into the daemon log (/tmp/claude-bridge.log) as well as
// the service-worker console, so the fleet is debuggable from the one log file an
// operator can read on a headless box. Best-effort.
function diag(msg) {
  console.log('[claude-bridge] ' + msg);
  try { send({ type: 'log', msg }); } catch {}
}

function scheduleReconnect(reason) {
  // setTimeout is the fast path, but it dies with the service worker: MV3 tears
  // the worker down while idle and the pending timer goes with it, so a
  // disconnect that happens just before a teardown would wait for the 1-minute
  // keepalive rather than retrying in 2s. Arm an alarm too — alarms survive
  // teardown and wake the worker to run them.
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });

  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected(reason);
  }, RECONNECT_DELAY_MS);
}

// Tear down a port we no longer trust. Chrome does NOT fire our own onDisconnect
// when we call disconnect() ourselves, so `port` must be cleared here.
function dropPort(reason) {
  const dead = port;
  port = null;
  console.warn(`[claude-bridge] dropping native port: ${reason}`);
  try { dead?.disconnect(); } catch {}
  ensureConnected('force-reconnect');
}

// Keepalive tick: prove the relay still answers, or replace it.
function heartbeat() {
  if (!port) return;
  if (lastPongAt && Date.now() - lastPongAt > PONG_GRACE_MS) {
    dropPort(`no pong for ${Math.round((Date.now() - lastPongAt) / 1000)}s`);
    return;
  }
  send({ type: 'ping' });
}

function ensureConnected(reason = 'startup') {
  if (port) return;

  let opened;
  try {
    opened = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.warn(`[claude-bridge] failed to connect native host (${reason}): ${err.message}`);
    scheduleReconnect('connect-error');
    return;
  }

  port = opened;
  // Assume alive at connect, so a fresh port is never judged by a stale pong.
  lastPongAt = Date.now();
  chrome.alarms.clear(RECONNECT_ALARM);

  opened.onMessage.addListener(onDaemonMessage);

  opened.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? 'unknown';
    console.warn(`[claude-bridge] native host disconnected: ${err}. Reconnecting in 2s...`);
    // Only clear if this is still the CURRENT port. A late onDisconnect from a
    // port we already replaced would otherwise null out its healthy successor
    // and leave the bridge down until the next keepalive tick.
    if (port === opened) {
      port = null;
      scheduleReconnect('disconnect');
    }
  });

  console.log(`[claude-bridge] connected to native host (${reason})`);

  // Announce what Chrome ACTUALLY loaded. A drift guard that hashes the CRX or
  // reads the registration file is checking what was staged, not what is
  // running, and /health's `chrome: true` proves only that a relay is
  // connected. This is the one version reading that cannot be stale: it comes
  // from the live service worker's own manifest, so no profile has to be
  // guessed at (Local State last_used, Default vs Profile 1) to find it.
  send({
    type: 'hello',
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
  });

  flushOutbox();
}

async function ensureKeepaliveAlarm() {
  // Create only when ABSENT, and never unconditionally. chrome.alarms.create()
  // on an existing name CANCELS AND REPLACES it, restarting the period from
  // zero — and wake() runs from eight call sites, including the top-level
  // statement that re-runs every time MV3 respawns the worker after its ~30s
  // idle teardown. On a box sitting on a live claude.ai tab, tabs.onUpdated
  // alone re-armed this to +60s far more often than once a minute, so a
  // 1-minute alarm could never reach its period: heartbeat() never ran,
  // lastPingAt stayed null on every node, and with it the PONG_GRACE_MS check
  // that is the ONLY thing that tears down a wedged port. The dispatch path was
  // self-defeating too — an alarm firing wakes the worker, whose top-level
  // wake() then replaced the very alarm that was mid-dispatch.
  //
  // Reproduced 2026-08-26 by bumping a claude.ai tab's hash every 15s: pings
  // stopped instantly and never resumed while the churn continued. It did NOT
  // reproduce on an idle tab, which is why this survived local verification.
  if (await chrome.alarms.get(KEEPALIVE_ALARM)) return;
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

function wake(reason) {
  ensureConnected(reason);
  ensureKeepaliveAlarm().catch((err) => {
    console.warn(`[claude-bridge] failed to create keepalive alarm: ${err.message}`);
  });
}

// Commands in flight, kept so a PAGE_UNREADABLE failure can be recovered and the
// command sent again. requestId → { msg, startedAt, tabId, recovery }.
// The daemon keeps one command in flight, so this holds one entry at a time.
const inflight = new Map();

// Below this much of the caller's budget, a recovery cannot finish and still
// leave the retried command time to run, so the failure is reported as is.
const MIN_BUDGET_FOR_RECOVERY_MS = 15_000;
const TAB_READY_TIMEOUT_MS = 20_000;

const CODE_URL = 'https://claude.ai/code';

async function onDaemonMessage(msg) {
  // Liveness reply — see heartbeat(). Handled before anything else so a pong can
  // never be mistaken for a command and go looking for a tab.
  if (msg?.type === 'pong') { lastPongAt = Date.now(); return; }

  inflight.set(msg.requestId, { msg, startedAt: Date.now(), tabId: null, recovery: null });
  await dispatchToPage(msg.requestId);
}

// The caller's remaining budget for this command, or Infinity if it gave none.
function budgetLeft(entry) {
  return typeof entry.msg.budgetMs === 'number'
    ? entry.msg.budgetMs - (Date.now() - entry.startedAt)
    : Infinity;
}

async function dispatchToPage(requestId) {
  const entry = inflight.get(requestId);
  if (!entry) return;
  const { cmd, sessionId, budgetMs: _budget, requestId: _rid, ...params } = entry.msg;

  // Prefer tabs on the Code sessions page, then active tab, then first.
  //
  // For create_session, prefer a tab already on the BLANK composer over one
  // parked on a session page. `/code/session_…` also matches "/code", so a tab
  // left on a session (loom had one sitting there since Aug 8) won this
  // selection every time and create failed on that box indefinitely — always
  // the same tab id, which reads like a race but is just a stuck tab. The
  // content script can route itself off a session page now, but starting from
  // the composer avoids the navigation entirely.
  //
  // "On the Code sessions page" means the composer or a session route ONLY.
  // This used to be `url.includes('/code')`, which also matches
  // /code/artifact/… — a page with no session sidebar. An artifact open in any
  // claude.ai tab then won the selection, every row lookup missed, and get_state
  // silently degraded to API-only (2026-09-25).
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  const isComposer = t => /^https:\/\/claude\.ai\/code\/?(\?|#|$)/.test(t.url ?? '');
  const isCodeApp  = t => /^https:\/\/claude\.ai\/code\/?(session_[A-Za-z0-9]+\/?)?(\?|#|$)/.test(t.url ?? '');
  const needsComposer = cmd === 'create_session' || cmd === 'create_session_preflight';
  const codeTabs = tabs.filter(isCodeApp);
  let tab = needsComposer
    ? (codeTabs.find(isComposer) ?? codeTabs.find(t => t.active) ?? codeTabs[0])
    : (codeTabs.find(t => t.active) ?? codeTabs[0]);

  if (!tab) {
    // No Code tab. This used to borrow whichever claude.ai tab was active — a
    // chat, settings or artifact page with no session sidebar, where every
    // lookup failed — or give up when there was no claude.ai tab at all. Open
    // one in the background instead: nothing the user is looking at moves.
    diag(`${cmd}: no claude.ai/code tab (${tabs.length} claude.ai tab(s) open) — opening one (requestId=${requestId})`);
    tab = await openCodeTab();
    if (!tab) {
      finish(requestId, {
        requestId, ok: false, code: 'PAGE_UNREADABLE',
        details: { reason: 'no_tab', recovery: { action: 'open_tab', outcome: 'failed' } },
        error: 'No claude.ai/code tab is open and one could not be opened and loaded within ' +
               `${TAB_READY_TIMEOUT_MS / 1000}s (signed out?) — the session was not checked`,
      });
      return;
    }
    entry.recovery ??= { action: 'open_tab', reason: 'no_tab' };
  }
  entry.tabId = tab.id;
  // Logs which tab a command was routed to — a login/interstitial URL here
  // explains a hung command (the in-page API fetch never authenticates).
  diag(`${cmd} → tab ${tab.id} ${tab.url} (requestId=${requestId})`);

  // The page adopts this as its deadline, so hand it what is actually left —
  // a retried command must not believe it has the whole budget again.
  const left = budgetLeft(entry);
  const pageMsg = { requestId, cmd, sessionId, ...params, ...(Number.isFinite(left) ? { budgetMs: left } : {}) };

  try {
    // Pass requestId so content script responds via chrome.runtime.sendMessage
    // instead of sendResponse (which is unreliable for long-running async ops
    // in MV3 — the service worker can lose the message channel).
    // sendMessage resolves with undefined immediately; the real response
    // arrives via the onMessage listener below.
    await chrome.tabs.sendMessage(tab.id, pageMsg);
  } catch (err) {
    if (err.message?.toLowerCase().includes('receiving end does not exist')) {
      diag(`${cmd}: content script not reachable on tab ${tab.id}, re-injecting (requestId=${requestId})`);
      try {
        const tabInfo = await chrome.tabs.get(tab.id);
        if (tabInfo.discarded) {
          // Tab is in browser-sleep state — activating it reloads and re-injects content script
          await chrome.tabs.update(tab.id, { active: true });
          await new Promise(r => setTimeout(r, 3500));
        } else {
          // page-bridge.js is content.js's MAIN-world half (React props reader);
          // re-inject both so readApprovalMeta() has someone to answer it.
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-bridge.js'], world: 'MAIN' });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        }
        await chrome.tabs.sendMessage(tab.id, pageMsg);
      } catch (retryErr) {
        await handleResponse(tabUnreachable(requestId, tab, retryErr));
      }
    } else {
      await handleResponse(tabUnreachable(requestId, tab, err));
    }
  }
}

// The page could not be reached at all, so nothing about the session was
// checked. Classified so a caller never reads it as "session missing": a
// crashed renderer ("Aw, Snap!") shows Chrome's error page, which refuses
// script injection; anything else is a content script that will not answer.
//
// A crashed claude.ai tab keeps its claude.ai URL, and injection into it fails
// with "Cannot access contents of the page. Extension manifest must request
// permission…" (observed 2026-10-05, renderer killed from Task Manager) — a
// permission error we cannot actually have on claude.ai, so on that host it
// means the error page.
function tabUnreachable(requestId, tab, err) {
  const msg = err?.message ?? String(err);
  const crashed = /error page|crash/i.test(msg)
               || (/cannot access contents of the page/i.test(msg) && /^https:\/\/claude\.ai\//.test(tab.url ?? ''));
  const reason = crashed ? 'tab_crashed' : 'content_unreachable';
  diag(`tab ${tab.id} unreachable (${reason}): ${msg}`);
  return {
    requestId,
    ok: false,
    code: 'PAGE_UNREADABLE',
    details: { reason, tabId: tab.id, url: tab.url ?? null, chromeError: msg },
    error: `claude.ai tab ${tab.id} is not responding (${crashed ? 'the page has crashed' : 'the bridge script cannot reach it'}): ${msg}. ` +
           'The session was not checked — this is NOT evidence it is missing.',
  };
}

// What to do about a failed response, or null to report it as is.
//
// Only PAGE_UNREADABLE is recoverable, and only the causes a reload or an Escape
// can plausibly fix. Every such failure happens BEFORE the command touched the
// session (no row to click, or the page never got the message), so sending the
// command again cannot double-apply it.
//   tab_crashed / content_unreachable — the page is dead or deaf: reload it.
//   error_screen / sidebar_empty      — the app failed to render: reload it.
//   dialog_open                       — a pop-up is over the app: press Escape.
// Not recovered: row_not_rendered (the app is fine; a reload would not add the
// row), off_code_page (routing only ever picks a Code tab now), and anything
// that is not a page problem at all (NOT_AUTHENTICATED, SESSION_NOT_FOUND…).
function recoveryFor(response) {
  if (response.ok || response.code !== 'PAGE_UNREADABLE') return null;
  const reason = response.details?.page?.reason ?? response.details?.reason;
  if (reason === 'tab_crashed' || reason === 'content_unreachable'
   || reason === 'error_screen' || reason === 'sidebar_empty') return { action: 'reload_tab', reason };
  if (reason === 'dialog_open') return { action: 'dismiss_dialog', reason };
  return null;
}

// Every response from the page comes through here: report it, or recover the
// page and send the command once more.
async function handleResponse(response) {
  const entry = inflight.get(response.requestId);
  const plan = entry && !entry.recovery?.retried ? recoveryFor(response) : null;

  if (plan) {
    const left = budgetLeft(entry);
    if (left < MIN_BUDGET_FOR_RECOVERY_MS) {
      diag(`${entry.msg.cmd}: ${plan.reason} — not recovering, only ${Math.round(left / 1000)}s of budget left`);
    } else {
      diag(`${entry.msg.cmd}: ${plan.reason} on tab ${entry.tabId} — ${plan.action}, then retrying (requestId=${response.requestId})`);
      entry.recovery = { ...plan, retried: true };
      const ok = await recoverPage(entry.tabId, plan.action, Math.min(TAB_READY_TIMEOUT_MS, left - 8000));
      if (ok) {
        await dispatchToPage(response.requestId);
        return;
      }
      diag(`${entry.msg.cmd}: ${plan.action} did not bring tab ${entry.tabId} back`);
      entry.recovery.outcome = 'page_not_ready';
    }
  }
  finish(response.requestId, response);
}

// Report the command's final answer, saying what recovery (if any) ran first.
function finish(requestId, response) {
  const entry = inflight.get(requestId);
  inflight.delete(requestId);
  const rec = entry?.recovery;
  if (rec) {
    const recovery = { action: rec.action, reason: rec.reason, outcome: rec.outcome ?? (response.ok ? 'recovered' : 'still_failing') };
    if (response.ok) {
      response.recovered = recovery;
    } else {
      response.details = { ...(response.details ?? {}), recovery };
      if (response.code === 'PAGE_UNREADABLE') {
        response.error += ` [recovery attempted: ${rec.action.replaceAll('_', ' ')} — ${recovery.outcome.replaceAll('_', ' ')}]`;
      }
    }
  }
  send(response);
}

// Open claude.ai/code in a background tab and wait for the app to render.
async function openCodeTab() {
  let tab;
  try { tab = await chrome.tabs.create({ url: CODE_URL, active: false }); }
  catch (e) { diag(`could not open ${CODE_URL}: ${e.message}`); return null; }
  return (await waitForApp(tab.id, TAB_READY_TIMEOUT_MS)) ? await chrome.tabs.get(tab.id) : null;
}

async function recoverPage(tabId, action, timeoutMs) {
  try {
    if (action === 'dismiss_dialog') {
      // Escape is what closes claude.ai's pop-ups (Settings, menus, pickers),
      // and on a confirm dialog it means cancel, so it can never accept
      // anything. Sent to the focused element and the document, the two places
      // a dialog listens.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
          (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', opts));
          document.dispatchEvent(new KeyboardEvent('keydown', opts));
        },
      });
      await new Promise(r => setTimeout(r, 600));
      return true;
    }
    // reload_tab. A crashed tab keeps its URL, so a reload returns it to the
    // same Code page. The content script is re-injected by the manifest.
    await chrome.tabs.reload(tabId);
    return await waitForApp(tabId, timeoutMs);
  } catch (e) {
    diag(`recovery ${action} on tab ${tabId} failed: ${e.message}`);
    return false;
  }
}

// Wait until the Code app has rendered in `tabId`: the sidebar has a row or the
// composer is up. Polled from the worker (not the page), so a throttled
// background tab cannot stretch it.
async function waitForApp(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 750));
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') continue;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(document.querySelector('[data-row-key^="code:"]')
                    || document.querySelector('div[contenteditable="true"][aria-label="Prompt"]')),
      });
      if (res?.result) {
        // Give the content script a moment to register its listener.
        await new Promise(r => setTimeout(r, 500));
        return true;
      }
    } catch { /* still loading, or showing an error page — keep waiting */ }
  }
  return false;
}

// Durable outbox: if the native port is momentarily down (worker respawn /
// reconnect in progress), buffer outgoing messages and flush on reconnect
// instead of silently dropping them.
const outbox = [];
const OUTBOX_MAX = 200;

function send(msg) {
  if (port) {
    try { port.postMessage(msg); return; }
    catch (e) { /* fall through to buffering */ }
  }
  if (outbox.length < OUTBOX_MAX) outbox.push(msg);
  ensureConnected('send-buffered');
}

function flushOutbox() {
  if (!port) return;
  while (outbox.length) {
    const m = outbox.shift();
    try { port.postMessage(m); } catch (e) { outbox.unshift(m); break; }
  }
}

// Handle command responses and proactive state changes from content scripts.
// Content scripts send results via chrome.runtime.sendMessage (type: 'cmd_response')
// instead of sendResponse, which avoids MV3 service-worker channel drops.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'cmd_response') {
    const { type, ...response } = msg;
    handleResponse(response);
  } else if (msg.type === 'state_change') {
    send(msg);
  } else if (msg.type === 'log') {
    // Diagnostic line from a content script → forward to the daemon log.
    send({ type: 'log', msg: msg.msg });
  } else if (msg.type === 'content_ready') {
    wake('content-ready');
  }
});

chrome.runtime.onStartup.addListener(() => wake('runtime-startup'));
chrome.runtime.onInstalled.addListener(() => wake('runtime-installed'));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    wake('keepalive-alarm');
    heartbeat();
  } else if (alarm.name === RECONNECT_ALARM) {
    wake('reconnect-alarm');
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (isClaudeUrl(changeInfo.url) || isClaudeUrl(tab.url)) {
    wake('claude-tab-updated');
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isClaudeUrl(tab.url)) wake('claude-tab-activated');
  } catch {}
});

wake('service-worker-startup');
