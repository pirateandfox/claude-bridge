#!/usr/bin/env node
// Always-running daemon: MCP Streamable-HTTP server (port 7878) + Unix socket for native-host relay

import { createServer as createNetServer } from 'net';
import { unlinkSync, existsSync }           from 'fs';
import express                              from 'express';
import crypto                               from 'crypto';
import { Server }                           from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport }    from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SOCKET_PATH, MCP_PORT }            from './shared.js';

// ── Chrome relay state ─────────────────────────────────────────────────────────
let chromeSocket = null;   // single connection from native-host relay
let chromeBuf    = '';
const pending    = new Map(); // requestId -> { resolve, reject, timer }

// ── Concurrency control ──────────────────────────────────────────────────────
// Only one request may be in-flight to Chrome at a time. Additional requests
// queue up; if the queue exceeds MAX_QUEUE the caller gets an immediate
// "bridge busy" error so agents can back off rather than silently stalling.
const MAX_QUEUE = 5;
let   inflightRequest = null;
const queue           = [];

const TIMEOUTS = { inject: 60_000, get_state: 60_000, warm_sessions: 120_000, create_session: 60_000 };

function sendToChrome(cmd, params = {}) {
  return new Promise((resolve, reject) => {
    if (!chromeSocket) return reject(new Error('Chrome not connected — is the extension loaded and a claude.ai tab open?'));
    if (queue.length >= MAX_QUEUE) {
      return reject(new Error(`Bridge is busy (${queue.length} requests queued). Try again shortly.`));
    }

    const task = { cmd, params, resolve, reject };

    if (inflightRequest) {
      log(`queuing ${cmd} (${queue.length + 1} in queue, in-flight: ${inflightRequest.cmd})`);
      queue.push(task);
    } else {
      dispatchTask(task);
    }
  });
}

function dispatchTask(task) {
  inflightRequest = task;

  const requestId = crypto.randomUUID();
  const ms = TIMEOUTS[task.cmd] ?? 30_000;
  let settled = false;

  const finish = (settler) => (value) => {
    if (settled) return;          // idempotent — timeout vs response race
    settled = true;
    clearTimeout(timer);
    pending.delete(requestId);
    inflightRequest = null;
    settler(value);
    drainQueue();
  };

  const timer = setTimeout(() => {
    log(`TIMEOUT ${task.cmd} after ${ms}ms — no Chrome response (requestId=${requestId})`);
    finish(task.reject)(new Error(`Timed out waiting for Chrome response (${task.cmd})`));
  }, ms);

  pending.set(requestId, { resolve: finish(task.resolve), reject: finish(task.reject), timer });
  log(`→ dispatch ${task.cmd} (requestId=${requestId}, timeout=${ms}ms)`);
  chromeSocket.write(JSON.stringify({ requestId, cmd: task.cmd, ...task.params }) + '\n');
}

function drainQueue() {
  if (inflightRequest || queue.length === 0) return;
  const next = queue.shift();
  if (!chromeSocket) {
    next.reject(new Error('Chrome disconnected while queued'));
    drainQueue();
    return;
  }
  dispatchTask(next);
}

function flushAllRequests(err) {
  const entries = [...pending.values()];
  pending.clear();
  inflightRequest = null;
  for (const entry of entries) {
    clearTimeout(entry.timer);
    try { entry.reject(err); } catch {}
  }
  while (queue.length) {
    try { queue.shift().reject(err); } catch {}
  }
}

function handleChromeMessage(msg) {
  // Diagnostic line relayed from the extension (content script / background) so
  // fleet debugging needs only this one log file, not the headless browser console.
  if (msg.type === 'log') {
    log(`[ext] ${msg.msg}`);
    return;
  }

  // Proactive state-change notification from content script
  if (msg.type === 'state_change') {
    log(`state_change: ${msg.sessionId} → ${msg.state}`);
    return;
  }

  const entry = msg.requestId && pending.get(msg.requestId);
  if (!entry) {
    // A response (or error) arrived that we have no pending entry for — it was
    // already settled/timed out, or the requestId got mangled in relay. Logging
    // it distinguishes "content never replied" (no orphan, just TIMEOUT) from
    // "content replied too late / uncorrelated" (orphan after TIMEOUT).
    if (msg.requestId) log(`orphan response (requestId=${msg.requestId}, ok=${msg.ok}) — already settled or uncorrelated`);
    return;
  }

  log(`← response ${msg.ok ? 'ok' : `error: ${msg.error}`} (requestId=${msg.requestId})`);
  if (msg.ok) entry.resolve(msg);
  else        entry.reject(new Error(msg.error ?? 'Chrome returned an error'));
}

// ── Unix socket server (native-host relay) ─────────────────────────────────────
if (existsSync(SOCKET_PATH)) { try { unlinkSync(SOCKET_PATH); } catch {} }

createNetServer((sock) => {
  log('native-host relay connected');
  chromeSocket = sock;
  chromeBuf    = '';

  sock.on('data', (chunk) => {
    chromeBuf += chunk.toString();
    const lines = chromeBuf.split('\n');
    chromeBuf   = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleChromeMessage(JSON.parse(line)); }
      catch (e) { log(`bad JSON from relay: ${e.message}`); }
    }
  });

  sock.on('close', () => {
    log('native-host relay disconnected');
    chromeSocket = null;
    flushAllRequests(new Error('Chrome disconnected'));
  });
  sock.on('error', (e) => log(`relay socket error: ${e.message}`));
}).listen(SOCKET_PATH, () => log(`socket listening at ${SOCKET_PATH}`));

// ── MCP tool definitions ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'claude_sessions_list',
    description: 'List all Claude Code cloud sessions visible in the sidebar.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'claude_sessions_warm',
    description: 'Pre-load all sessions by clicking through each one. Call this before batch get_state calls — it forces the UI to hydrate branch bars so subsequent reads are reliable. Returns the number of sessions warmed.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'claude_session_get_state',
    description: 'Get detailed state for a specific session: running/ready/merged/pr_open/unknown, branch info, CI status, model, effort. IMPORTANT: "unknown" means the row could not be read (not hydrated yet) — it does NOT mean idle. Call claude_sessions_warm and re-read before concluding a session is free; if you must act on an unknown, treat it as busy. branchBar/prUrl are also null until the session has been warmed, which reads as "no PR" rather than "not loaded" — so warm before any batch read. Also returns usagePct — the ACCOUNT plan usage % ("Usage: plan N%"), which is global, NOT per-session (same value for every session).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID from claude_sessions_list' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'claude_session_inject',
    description: 'Send a prompt to a session. Navigates to the session if not already active, submits the prompt, then spends up to ~15s confirming delivery before returning — it does NOT return the instant the prompt is submitted, though it still returns long before the agent finishes working. Poll get_state to know when the run itself finishes. Aborts rather than injecting if the shared tab cannot be confirmed parked on session_id. Returns { injected, sessionId, verified, turnId }: verified:true means the prompt was observed as a new user turn in THAT session (turnId is checkable via get_transcript). verified:false means delivery could not be proven within the confirmation budget — read the transcript before retrying, since a retry of an inject that did land will double-post.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        prompt:     { type: 'string' },
      },
      required: ['session_id', 'prompt'],
    },
  },
  {
    name: 'claude_session_create',
    description: 'Open a new Claude Code session. A repo and an initial prompt are required: clicking "New session" only opens a blank composer, and the session is created when the prompt is submitted against the chosen repo.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string',  description: 'Repository to run the session against, "owner/name" (e.g. "pirateandfox/claude-bridge"). Must match a repo in the picker.' },
        prompt: { type: 'string',  description: 'Initial prompt to send — this is what creates the session' },
        model:  { type: 'string',  description: 'Model name e.g. "Opus 4.7", "Sonnet 4.6", "Haiku 4.5"' },
        effort: { type: 'string',  description: '"Low" | "Medium" | "High" | "Max"' },
      },
      required: ['repo', 'prompt'],
    },
  },
  {
    name: 'claude_session_archive',
    description: 'Archive a session (removes it from the active sidebar list).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'claude_session_create_pr',
    description: 'Click the "Create PR" button for a session that has uncommitted changes on a branch.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'claude_session_set_ci_options',
    description: 'Set the CI monitoring checkboxes for a session that has an open PR.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        autofix:    { type: 'boolean', description: 'Enable "Auto-fix CI & address comments"' },
        automerge:  { type: 'boolean', description: 'Enable "Auto-merge when ready"' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'claude_session_get_transcript',
    description: 'Read the conversation transcript for a session. Returns turns with role (user/assistant), text content, tool-use summaries, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID from claude_sessions_list' },
        last_n:     { type: 'number', description: 'Return only the last N turns (default: all)' },
      },
      required: ['session_id'],
    },
  },
];

function createMcpServer() {
  const server = new Server(
    { name: 'claude-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    // Log every tool call with a prompt-truncated arg summary, so the daemon log
    // shows exactly which call ran and with what — paired with the dispatch /
    // response / TIMEOUT lines, every outcome is explainable from this one file.
    const argSummary = { ...args };
    if (typeof argSummary.prompt === 'string') argSummary.prompt = `<${argSummary.prompt.length} chars>`;
    log(`MCP call: ${name} ${JSON.stringify(argSummary)}`);

    try {
      let result;

      switch (name) {
        case 'claude_sessions_list': {
          const r = await sendToChrome('list_sessions');
          result  = r.sessions;
          break;
        }
        case 'claude_sessions_warm': {
          const r = await sendToChrome('warm_sessions');
          result  = { warmed: r.warmed };
          break;
        }
        case 'claude_session_get_state': {
          const r = await sendToChrome('get_state', { sessionId: args.session_id });
          result  = { state: r.state, branchBar: r.branchBar, prUrl: r.branchBar?.prUrl ?? null, model: r.model, effort: r.effort, usagePct: r.usagePct };
          break;
        }
        case 'claude_session_inject': {
          const r = await sendToChrome('inject', { sessionId: args.session_id, prompt: args.prompt });
          // Echo back the session we were asked for plus proof of landing, so a
          // caller can tell "accepted" from "delivered". `injected: true` alone
          // could not distinguish those — see the 2026-07-29 misroute.
          result = {
            injected:  true,
            sessionId: args.session_id,
            verified:  r?.verified ?? false,
            turnId:    r?.turnId ?? null,
          };
          break;
        }
        case 'claude_session_create': {
          const r = await sendToChrome('create_session', { repo: args.repo, model: args.model, effort: args.effort, prompt: args.prompt });
          result  = { sessionId: r.sessionId };
          break;
        }
        case 'claude_session_archive': {
          await sendToChrome('archive', { sessionId: args.session_id });
          result = { archived: true };
          break;
        }
        case 'claude_session_create_pr': {
          await sendToChrome('create_pr', { sessionId: args.session_id });
          result = { ok: true };
          break;
        }
        case 'claude_session_set_ci_options': {
          await sendToChrome('set_ci_options', { sessionId: args.session_id, autofix: args.autofix, automerge: args.automerge });
          result = { ok: true };
          break;
        }
        case 'claude_session_get_transcript': {
          const r = await sendToChrome('get_transcript', { sessionId: args.session_id, lastN: args.last_n });
          result  = r.turns;
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const summary = Array.isArray(result) ? `${result.length} item(s)`
        : (result && typeof result === 'object') ? JSON.stringify(result).slice(0, 200)
        : String(result);
      log(`MCP ok: ${name} → ${summary}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
      log(`MCP error: ${name}: ${err.message}`);
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── MCP Streamable-HTTP server ─────────────────────────────────────────────────
const app      = express();
const sessions = new Map(); // sessionId -> { transport, server }

app.use(express.json());

// Single endpoint handles initialize (POST), streaming (GET), and messages (POST)
app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — only POST is valid for initialize
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = createMcpServer();

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      log(`MCP session closed (${transport.sessionId})`);
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, { transport, server });
    log(`MCP session opened (${transport.sessionId})`);
  }
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  chrome: !!chromeSocket,
  inflight: inflightRequest?.cmd ?? null,
  queued: queue.length,
}));

app.listen(MCP_PORT, '127.0.0.1', () =>
  log(`MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`),
);

function log(msg) { process.stderr.write(`[daemon ${new Date().toISOString().slice(11, 23)}] ${msg}\n`); }

process.on('SIGTERM', () => { log('SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT received, exiting');  process.exit(0); });
