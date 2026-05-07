const HOST_NAME = 'com.claudebridge.host';

let port = null;

function connect() {
  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener(onDaemonMessage);

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? 'unknown';
    console.warn(`[claude-bridge] native host disconnected: ${err}. Reconnecting in 2s...`);
    port = null;
    setTimeout(connect, 2000);
  });

  console.log('[claude-bridge] connected to native host');
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
    const response = await chrome.tabs.sendMessage(tab.id, { cmd, sessionId, ...params });
    send({ requestId, ...response });
  } catch (err) {
    send({ requestId, ok: false, error: err.message });
  }
}

function send(msg) {
  port?.postMessage(msg);
}

// Forward state-change notifications from content scripts to daemon
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state_change') send(msg);
});

connect();
