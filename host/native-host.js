#!/usr/bin/env node
// Thin relay: Chrome native messaging (stdin/stdout) <-> daemon Unix socket
// Chrome spawns this process; it forwards all messages to the always-running daemon.

import { createConnection } from 'net';
import { SOCKET_PATH } from './shared.js';

const socket = createConnection(SOCKET_PATH);
let socketReady = false;
const queue = [];

socket.on('connect', () => {
  socketReady = true;
  for (const msg of queue) socket.write(msg);
  queue.length = 0;
});

socket.on('error', (err) => {
  process.stderr.write(`[native-host] socket error: ${err.message}\n`);
  process.exit(1);
});

// Daemon -> Chrome: read newline-delimited JSON from socket, write native messaging frames
let buf = '';
socket.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop(); // last element may be incomplete
  for (const line of lines) {
    if (!line.trim()) continue;
    const encoded = Buffer.from(line, 'utf8');
    const header  = Buffer.alloc(4);
    header.writeUInt32LE(encoded.length, 0);
    process.stdout.write(header);
    process.stdout.write(encoded);
  }
});

// Chrome -> Daemon: read native messaging frames from stdin, write JSON to socket
let stdinBuf = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);

  while (stdinBuf.length >= 4) {
    const msgLen = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + msgLen) break;

    const msgJson = stdinBuf.slice(4, 4 + msgLen).toString('utf8');
    stdinBuf = stdinBuf.slice(4 + msgLen);

    const line = msgJson + '\n';
    if (socketReady) {
      socket.write(line);
    } else {
      queue.push(line);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
