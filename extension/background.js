const HOST_NAME = 'com.claudebridge.host';
const KEEPALIVE_ALARM = 'claude-bridge-keepalive';
const RECONNECT_DELAY_MS = 2000;

let port = null;
let reconnectTimer = null;

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
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected(reason);
  }, RECONNECT_DELAY_MS);
}

function ensureConnected(reason = 'startup') {
  if (port) return;

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.warn(`[claude-bridge] failed to connect native host (${reason}): ${err.message}`);
    scheduleReconnect('connect-error');
    return;
  }

  port.onMessage.addListener(onDaemonMessage);

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? 'unknown';
    console.warn(`[claude-bridge] native host disconnected: ${err}. Reconnecting in 2s...`);
    port = null;
    scheduleReconnect('disconnect');
  });

  console.log(`[claude-bridge] connected to native host (${reason})`);
  flushOutbox();
}

async function ensureKeepaliveAlarm() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

function wake(reason) {
  ensureConnected(reason);
  ensureKeepaliveAlarm().catch((err) => {
    console.warn(`[claude-bridge] failed to create keepalive alarm: ${err.message}`);
  });
}

async function onDaemonMessage(msg) {
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
  const codeTab = cmd === 'create_session'
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
  if (alarm.name === KEEPALIVE_ALARM) wake('keepalive-alarm');
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
