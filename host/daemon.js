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

const TIMEOUTS = { inject: 60_000, get_state: 60_000, warm_sessions: 120_000 };

function sendToChrome(cmd, params = {}) {
  return new Promise((resolve, reject) => {
    if (!chromeSocket) return reject(new Error('Chrome not connected — is the extension loaded and a claude.ai tab open?'));

    const requestId = crypto.randomUUID();
    const ms = TIMEOUTS[cmd] ?? 30_000;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Timed out waiting for Chrome response'));
    }, ms);

    pending.set(requestId, { resolve, reject, timer });
    chromeSocket.write(JSON.stringify({ requestId, cmd, ...params }) + '\n');
  });
}

function handleChromeMessage(msg) {
  // Proactive state-change notification from content script
  if (msg.type === 'state_change') {
    log(`state_change: ${msg.sessionId} → ${msg.state}`);
    return;
  }

  const entry = msg.requestId && pending.get(msg.requestId);
  if (!entry) return;

  clearTimeout(entry.timer);
  pending.delete(msg.requestId);

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

  sock.on('close', () => { log('native-host relay disconnected'); chromeSocket = null; });
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
    description: 'Get detailed state for a specific session: running/ready/merged/pr_open, branch info, CI status, model, usage.',
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
    description: 'Send a prompt to a session. Navigates to the session if not already active, submits the prompt, and returns immediately. Poll get_state to know when it finishes.',
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
    description: 'Open a new Claude Code session with optional model, effort level, and initial prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string',  description: 'Initial prompt to send after creating the session' },
        model:  { type: 'string',  description: 'Model name e.g. "Opus 4.7", "Sonnet 4.6", "Haiku 4.5"' },
        effort: { type: 'string',  description: '"Low" | "Medium" | "High" | "Max"' },
      },
      required: [],
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
          await sendToChrome('inject', { sessionId: args.session_id, prompt: args.prompt });
          result = { injected: true };
          break;
        }
        case 'claude_session_create': {
          const r = await sendToChrome('create_session', { model: args.model, effort: args.effort, prompt: args.prompt });
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

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
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

app.get('/health', (_req, res) => res.json({ ok: true, chrome: !!chromeSocket }));

app.listen(MCP_PORT, '127.0.0.1', () =>
  log(`MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`),
);

function log(msg) { process.stderr.write(`[daemon] ${msg}\n`); }

process.on('SIGTERM', () => { log('SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT received, exiting');  process.exit(0); });
