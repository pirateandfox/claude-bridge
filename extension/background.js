const HOST_NAME = 'com.claudebridge.host';
const KEEPALIVE_ALARM = 'claude-bridge-keepalive';
const RECONNECT_DELAY_MS = 2000;

let port = null;
let reconnectTimer = null;

function isClaudeUrl(url) {
  return typeof url === 'string' && url.startsWith('https://claude.ai/');
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
    send({ requestId, ok: false, error: 'No claude.ai tab is open' });
    return;
  }

  // Prefer tabs on the Code sessions page, then active tab, then first
  const codeTab = tabs.find(t => t.url?.includes('/code'));
  const tab = codeTab ?? tabs.find(t => t.active) ?? tabs[0];

  try {
    // Pass requestId so content script responds via chrome.runtime.sendMessage
    // instead of sendResponse (which is unreliable for long-running async ops
    // in MV3 — the service worker can lose the message channel).
    // sendMessage resolves with undefined immediately; the real response
    // arrives via the onMessage listener below.
    await chrome.tabs.sendMessage(tab.id, { requestId, cmd, sessionId, ...params });
  } catch (err) {
    if (err.message?.toLowerCase().includes('receiving end does not exist')) {
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

function send(msg) {
  port?.postMessage(msg);
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
