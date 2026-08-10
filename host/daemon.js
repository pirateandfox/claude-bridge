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
let extension    = null;   // {version, id, since} reported by the loaded extension

// Requests whose timeout we already reported to the caller, kept just long
// enough to recognise a late reply for what it is. Bounded — this is a
// diagnostic, not a ledger.
const timedOutRequests = new Map();   // requestId -> {cmd, at}
const orphanedSuccesses = [];         // work that completed after the caller gave up

function rememberTimedOut(requestId, cmd) {
  timedOutRequests.set(requestId, { cmd, at: Date.now() });
  // Keep only the recent ones; a reply arriving minutes later is already beyond
  // anything the caller could correlate.
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, rec] of timedOutRequests) {
    if (rec.at < cutoff) timedOutRequests.delete(id);
  }
  while (timedOutRequests.size > 100) {
    timedOutRequests.delete(timedOutRequests.keys().next().value);
  }
}
let chromeBuf    = '';
const pending    = new Map(); // requestId -> { resolve, reject, timer }

// ── Concurrency control ──────────────────────────────────────────────────────
// Only one request may be in-flight to Chrome at a time. Additional requests
// queue up; if the queue exceeds MAX_QUEUE the caller gets an immediate
// "bridge busy" error so agents can back off rather than silently stalling.
const MAX_QUEUE = 5;
let   inflightRequest = null;
const queue           = [];

// create_session is the long pole: from a fresh composer with no repo attached
// it navigates, opens a repo picker listing every repo on the account, sets
// model and effort, submits, then waits for the new session id to land in the
// URL. That legitimately exceeded 60s on 2026-08-08 — the session was created
// correctly but the caller got a timeout error, which is the worst outcome:
// a retry would create a SECOND session for the same task.
const TIMEOUTS = { inject: 60_000, get_state: 60_000, warm_sessions: 120_000, create_session: 150_000 };

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
    // Remember what timed out. A late response is not merely uncorrelated — for
    // a create it may report a session that now exists and that the caller was
    // told did not. Keeping the cmd is what lets handleChromeMessage say so.
    rememberTimedOut(requestId, task.cmd);
    finish(task.reject)(new Error(`Timed out waiting for Chrome response (${task.cmd})`));
  }, ms);

  pending.set(requestId, { resolve: finish(task.resolve), reject: finish(task.reject), timer });
  log(`→ dispatch ${task.cmd} (requestId=${requestId}, timeout=${ms}ms)`);
  // Tell the page how long the caller will actually wait, so it can refuse to
  // start anything irreversible it cannot finish and report inside that window.
  chromeSocket.write(JSON.stringify({ requestId, cmd: task.cmd, budgetMs: ms, ...task.params }) + '\n');
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
  // Identity of the extension that is actually running, sent on every connect.
  // Surfaced via /health so a fleet drift check can verify the LOADED version
  // rather than a staged CRX or a registration file — neither of which reflects
  // what Chrome loaded, and neither of which knows which profile is in use.
  if (msg.type === 'hello') {
    extension = { version: msg.extensionVersion ?? null, id: msg.extensionId ?? null, since: new Date().toISOString() };
    log(`extension connected: v${extension.version} (${extension.id})`);
    return;
  }

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
    if (!msg.requestId) return;

    const timedOut = timedOutRequests.get(msg.requestId);

    // A late SUCCESS is the dangerous orphan: the caller was told this failed,
    // so any state it created is state nobody is tracking. The content script
    // now refuses to submit without budget to report, which should prevent it —
    // but if one ever gets through, it must be loud and it must be recoverable,
    // not a debug line in a log file nobody greps.
    if (msg.ok && timedOut) {
      const record = { cmd: timedOut.cmd, requestId: msg.requestId, sessionId: msg.sessionId ?? null, at: new Date().toISOString() };
      orphanedSuccesses.push(record);
      if (orphanedSuccesses.length > 50) orphanedSuccesses.shift();
      log(
        `ORPHAN SUCCESS — ${timedOut.cmd} completed AFTER its timeout was reported to the caller` +
        (msg.sessionId ? ` and created/affected ${msg.sessionId}` : '') +
        `. The caller believes this failed; reconcile before retrying (requestId=${msg.requestId})`
      );
      return;
    }

    log(`orphan response (requestId=${msg.requestId}, ok=${msg.ok}) — already settled or uncorrelated`);
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
    extension    = null;   // never report a version for an extension that is gone
    flushAllRequests(new Error('Chrome disconnected'));
  });
  sock.on('error', (e) => log(`relay socket error: ${e.message}`));
}).listen(SOCKET_PATH, () => log(`socket listening at ${SOCKET_PATH}`));

// ── MCP tool definitions ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'claude_sessions_list',
    description: 'List active (non-archived) Claude Code cloud sessions — the ones still visible in the sidebar. Archived sessions are finished work retained only for history and are excluded by default; pass include_archived: true to get the full account history instead. Each row carries workerStatus (idle|… — the reliable busy/idle signal) and statusBucket, whose semantics are UNVERIFIED and must not be routed on — see claude_session_get_state for what has been ruled out.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Include archived sessions (finished work kept for history). Defaults to false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'claude_sessions_warm',
    description: 'Pre-load all sessions by clicking through each one. Call this before batch get_state calls — it forces the UI to hydrate branch bars so subsequent reads are reliable. Returns the number of sessions warmed.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'claude_session_get_state',
    description: 'Get detailed state for a specific session. `state` (running/ready/archived/unknown) now comes from the API, so it is reliable without warming — "running" means the session is actually working, "unknown" means neither the API nor the DOM could answer and must be treated as busy, never as idle. Also returns workerStatus (idle|… — the raw busy signal; this one is reliable) and statusBucket (review_ready|blocked|completed|failed). WARNING: statusBucket semantics are UNVERIFIED — do NOT route work on it. It is passed through raw for observation only. Ruled out on 2026-08-03: it is not "PR merged" (two blocked sessions had open PRs), not derived from PR state (an open+conflicting PR appeared in both buckets), and not "ended asking a human" (a blocked session asked nothing; a review_ready one asked). A merged, finished session still reads "blocked", so it does not clear on completion and cannot mean "needs attention". branchBar/prUrl/model/effort are still scraped from the UI and are null until the session has been warmed — that reads as "no PR" rather than "not loaded", so call claude_sessions_warm before a batch read if you need branch data. usagePct is the ACCOUNT plan meter, global and identical for every session.',
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
          const r = await sendToChrome('list_sessions', { includeArchived: args.include_archived === true });
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
          result  = { state: r.state, statusBucket: r.statusBucket ?? null, workerStatus: r.workerStatus ?? null, branchBar: r.branchBar, prUrl: r.branchBar?.prUrl ?? null, model: r.model, effort: r.effort, usagePct: r.usagePct };
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
  // null when the relay is up but no extension has announced itself — which is
  // exactly the state `chrome: true` alone cannot distinguish from a healthy one.
  extensionVersion: chromeSocket ? extension?.version ?? null : null,
  extensionId:      chromeSocket ? extension?.id ?? null : null,
  inflight: inflightRequest?.cmd ?? null,
  queued: queue.length,
  // Work that finished after its caller was told it had failed — usually a
  // session that exists but that nothing is tracking. Non-empty means reconcile
  // before retrying, and it is deliberately here rather than only in the log.
  orphanedSuccesses,
}));

app.listen(MCP_PORT, '127.0.0.1', () =>
  log(`MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`),
);

function log(msg) { process.stderr.write(`[daemon ${new Date().toISOString().slice(11, 23)}] ${msg}\n`); }

process.on('SIGTERM', () => { log('SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT received, exiting');  process.exit(0); });
