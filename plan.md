# claude-bridge — Build Plan

A Chrome extension + native messaging host + MCP server that gives any local agent
programmatic read/write access to Claude Code cloud sessions running on claude.ai.

**Scope of this document:** The bridge only. Not the polling agent. Not FlightDesk.
The bridge exposes three tools and does nothing else.

---

## The Problem

There is no API for Claude Code cloud sessions. You can kick one off, but you can't:
- Know when it's done thinking
- Read its current state
- Post a follow-up prompt without opening a browser tab yourself

This is the missing piece in any agentic workflow that uses Claude Code in the cloud.

---

## What This Is Not

- Not a polling agent
- Not a FlightDesk integration
- Not a GitHub CI checker
- Not a task manager

Those things call this. This just exposes the browser session as MCP tools.

---

## Architecture

```
Local agent (Task OS / Claude Code / anything)
    │
    │  MCP protocol (stdio or HTTP)
    ▼
Native Host Daemon  ──────────────────────────────┐
(always running, registered as MCP server          │  native messaging
 AND Chrome native messaging host)                 │  (stdin/stdout)
                                                   ▼
                                        Chrome Extension
                                        (background service worker)
                                                   │
                                                   │  chrome.tabs / content script messaging
                                                   ▼
                                        Content Script
                                        (injected into claude.ai tabs)
                                                   │
                                                   │  DOM read/write
                                                   ▼
                                        claude.ai session
```

Three components. One direction of control (agent → daemon → extension → DOM).

---

## Component 1: Chrome Extension (Manifest V3)

### background.js (service worker)
- Maintains the native messaging connection to the daemon
- Tracks all open claude.ai tabs: `Map<tabId, sessionInfo>`
- Receives commands from daemon, routes to correct tab via `chrome.tabs.sendMessage`
- Receives state updates from content scripts, forwards to daemon

### content.js (injected into claude.ai)
- Runs on every `claude.ai/chat/*` and `claude.ai/project/*/chat/*` page
- Responsible for two things: **state detection** and **prompt injection**
- Reports state changes to background.js proactively (MutationObserver)

**State detection strategy:**
Claude.ai renders a stop button while generating and a send button while idle.
Watch for these via MutationObserver — don't poll.

```js
// Thinking: stop button is present and visible
// Idle: stop button absent OR send button enabled
const isThinking = () => !!document.querySelector('[data-testid="stop-button"]')
```

States:
- `idle` — Claude is waiting for input
- `thinking` — Claude is generating a response
- `complete` — same as idle, but set immediately after transitioning out of thinking
  (lets the daemon know "just finished" vs "has been waiting")

**Prompt injection strategy:**
React apps ignore direct `.value =` assignment — they use synthetic events.
Use the clipboard approach as the most reliable cross-version method:

```js
async function injectPrompt(text) {
  const input = document.querySelector('div[contenteditable="true"]') // or textarea
  input.focus()
  await navigator.clipboard.writeText(text)
  document.execCommand('paste')          // triggers React's onChange
  await waitForInputPopulated(input)
  const sendBtn = document.querySelector('[data-testid="send-button"]')
  sendBtn.click()
}
```

Fallback: `input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))`.
Test both — claude.ai React version determines which works.

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "claude-bridge",
  "version": "0.1.0",
  "permissions": ["nativeMessaging", "tabs", "scripting", "clipboardWrite"],
  "host_permissions": ["https://claude.ai/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://claude.ai/chat/*", "https://claude.ai/project/*/chat/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "nativeMessaging": { "allowed_origins": ["com.claudebridge.host"] }
}
```

---

## Component 2: Native Messaging Host (Daemon)

Single Node.js (or Bun) process that does two things simultaneously:

1. **Native messaging host** — Chrome extension connects to it using the registered host name
2. **MCP server** — exposes tools to local agents via stdio transport

### Lifecycle
- Runs as a macOS launchd daemon (auto-starts on login)
- Chrome extension connects when first needed; reconnects if dropped
- MCP clients connect via stdio (Claude Code adds it to `~/.claude.json`)

### Native host registration manifest
Registered at:
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.claudebridge.host.json`

```json
{
  "name": "com.claudebridge.host",
  "description": "claude-bridge native host",
  "path": "/path/to/claude-bridge/host/index.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

`install.sh` writes this file with the correct paths automatically.

### Internal message protocol (daemon ↔ extension)
Simple JSON over native messaging:

```
// daemon → extension
{ "cmd": "inject", "tabId": 123, "prompt": "fix the failing test" }
{ "cmd": "get_state", "tabId": 123 }
{ "cmd": "list_sessions" }

// extension → daemon
{ "type": "state_update", "tabId": 123, "state": "thinking", "url": "..." }
{ "type": "session_list", "sessions": [...] }
{ "type": "inject_ack", "tabId": 123, "success": true }
```

---

## Component 3: MCP Server (exposed by the daemon)

Three tools. That's it.

### `claude_sessions_list`
Returns all currently open Claude.ai chat sessions.

```json
{
  "sessions": [
    {
      "id": "tab_123",
      "url": "https://claude.ai/chat/abc-def",
      "title": "Fix failing CI tests",
      "state": "idle"
    }
  ]
}
```

### `claude_session_get_state`
Input: `{ "session_id": "tab_123" }`

```json
{
  "session_id": "tab_123",
  "state": "thinking | idle | complete | unreachable",
  "state_since": "2026-04-29T14:32:00Z"
}
```

`unreachable` = tab was closed or lost connection.

### `claude_session_inject`
Input: `{ "session_id": "tab_123", "prompt": "The CI is failing because..." }`

```json
{
  "success": true,
  "session_id": "tab_123",
  "injected_at": "2026-04-29T14:32:05Z"
}
```

Returns immediately after injection is confirmed (prompt submitted). Does NOT wait
for Claude to finish responding — the caller polls `get_state` for that.

---

## File Structure

```
claude-bridge/
  extension/
    manifest.json
    background.js
    content.js
    icons/
      icon-16.png
      icon-48.png
      icon-128.png
  host/
    index.js          ← daemon: native messaging + MCP server
    package.json
    install.sh        ← registers native host manifest, sets up launchd
    com.claudebridge.host.plist   ← launchd config
    com.claudebridge.host.json    ← native host manifest template
  plan.md
```

---

## Build Order (2 days)

### Day 1 — Extension + DOM layer
Goal: manually verify you can read state and inject prompts from the browser console,
then wrap it in the extension.

1. Content script: state detection via MutationObserver
2. Content script: prompt injection (test clipboard approach first)
3. Background service worker: tab tracking, message routing
4. Manual test: open claude.ai, load unpacked extension, verify state changes log correctly,
   verify injected prompts submit cleanly
5. Native messaging: stub the daemon with a simple echo server to verify
   extension ↔ daemon channel works

### Day 2 — Daemon + MCP server
Goal: Claude Code (or any agent) can call all three tools and get correct results.

1. Daemon process: native messaging host protocol (stdin/stdout framing)
2. Daemon: MCP server with three tools wired to extension message relay
3. `install.sh`: writes native host manifest + launchd plist, loads daemon
4. Add to `~/.claude.json`, verify tools appear in Claude Code
5. End-to-end test: from Claude Code CLI, call `inject`, watch prompt appear in browser

---

## Known Risks

- **Claude.ai DOM changes** — Anthropic can rename `data-testid` attributes at any time.
  Keep selectors in a single constants file so updates are one-line fixes.

- **Manifest V3 service worker lifecycle** — MV3 service workers can be terminated by
  Chrome when idle. The native messaging connection may drop. Background.js needs to
  reconnect on demand rather than assuming a persistent connection.

- **Clipboard permission prompt** — `clipboardWrite` may trigger a one-time user permission
  prompt in some Chrome versions. Test early.

- **Anthropic ToS** — Consumer ToS prohibits automated access "through a bot, script, or
  otherwise" except via API key or explicit permission. This tool is fine for personal use.
  Do not publish until you've either confirmed with Anthropic or they've released an official
  cloud sessions API. At that point, replace the DOM layer with API calls; MCP interface stays
  identical.

---

## Out of Scope (handled by the polling agent, not this repo)

- Knowing which sessions belong to which FlightDesk tasks
- Reading GitHub PR status or CI results
- Deciding what prompt to inject
- Notifying Task OS when a task is ready for review
- Any FlightDesk-specific logic

The bridge just gives agents eyes and a voice in the browser. What they do with that
is someone else's problem.
