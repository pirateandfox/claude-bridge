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

async function onDaemonMessage(msg) {
  // Liveness reply — see heartbeat(). Handled before anything else so a pong can
  // never be mistaken for a command and go looking for a tab.
  if (msg?.type === 'pong') { lastPongAt = Date.now(); return; }

  const { requestId, cmd, sessionId, ...params } = msg;

  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) {
    diag(`${cmd}: no claude.ai tab open (requestId=${requestId})`);
    send({ requestId, ok: false, error: 'No claude.ai tab is open' });
    return;
  }

  // Prefer tabs on the Code sessions page, then active tab, then first.
  //
  // For create_session, prefer a tab already on the BLANK composer over one
  // parked on a session page. `/code/session_…` also matches "/code", so a tab
  // left on a session (loom had one sitting there since Aug 8) won this
  // selection every time and create failed on that box indefinitely — always
  // the same tab id, which reads like a race but is just a stuck tab. The
  // content script can route itself off a session page now, but starting from
  // the composer avoids the navigation entirely.
  const isComposer = t => /^https:\/\/claude\.ai\/code\/?(\?|#|$)/.test(t.url ?? '');
  const needsComposer = cmd === 'create_session' || cmd === 'create_session_preflight';
  const codeTab = needsComposer
    ? (tabs.find(isComposer) ?? tabs.find(t => t.url?.includes('/code')))
    : tabs.find(t => t.url?.includes('/code'));
  const tab = codeTab ?? tabs.find(t => t.active) ?? tabs[0];
  // Logs which tab a command was routed to — a login/interstitial URL here
  // explains a hung command (the in-page API fetch never authenticates).
  diag(`${cmd} → tab ${tab.id} ${tab.url} (requestId=${requestId})`);

  try {
    // Pass requestId so content script responds via chrome.runtime.sendMessage
    // instead of sendResponse (which is unreliable for long-running async ops
    // in MV3 — the service worker can lose the message channel).
    // sendMessage resolves with undefined immediately; the real response
    // arrives via the onMessage listener below.
    await chrome.tabs.sendMessage(tab.id, { requestId, cmd, sessionId, ...params });
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
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        }
        await chrome.tabs.sendMessage(tab.id, { requestId, cmd, sessionId, ...params });
      } catch (retryErr) {
        send({ requestId, ok: false, error: retryErr.message });
      }
    } else {
      send({ requestId, ok: false, error: err.message });
    }
  }
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
    send(response);
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
