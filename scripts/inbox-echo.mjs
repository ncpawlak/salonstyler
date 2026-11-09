#!/usr/bin/env node
// Zero-dependency echo server for the iOS Shortcut bridge spike (issue #6).
// Usage: node scripts/inbox-echo.mjs   (env: PORT=8787, BRIDGE_TOKEN=<token>, LOG_FILE=inbox-echo.log)
// See docs/spikes/ios-shortcut-keyword-bridge.md.

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.BRIDGE_TOKEN ?? '';
const LOG_FILE = process.env.LOG_FILE ?? '';
const MAX_BODY = 64 * 1024;
let count = 0;

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, { ok: true, received: count });
  }
  if (req.method !== 'POST' || pathname !== '/inbox') {
    return send(res, 404, { error: 'POST /inbox or GET /health' });
  }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: 'body too large' });
      req.destroy();
    } else {
      chunks.push(c);
    }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const arrivedAt = new Date().toISOString();
    const raw = Buffer.concat(chunks).toString('utf8');
    const token = req.headers['x-bridge-token'] ?? '';
    const tokenOk = !TOKEN || token === TOKEN;

    let body = null;
    let parseError = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch (e) {
      parseError = e.message;
    }

    const entry = {
      n: ++count,
      arrivedAt,
      tokenOk,
      contentType: req.headers['content-type'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      body,
      raw: body ? undefined : raw,
      parseError,
    };

    console.log(`\n#${entry.n} ${arrivedAt} token=${tokenOk ? 'ok' : 'BAD'}`);
    console.log(JSON.stringify(entry, null, 2));
    if (LOG_FILE) appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

    if (!tokenOk) return send(res, 401, { error: 'bad X-Bridge-Token' });
    // Mirrors the planned /inbox contract; in v1 Draft mode the Shortcut ignores the reply.
    send(res, 200, { action: 'none', echo: { n: entry.n, arrivedAt } });
  });
});

server.listen(PORT, () => {
  console.log(`inbox-echo listening on http://localhost:${PORT}  (POST /inbox, GET /health)`);
  console.log(
    TOKEN ? 'Requiring X-Bridge-Token header.' : 'BRIDGE_TOKEN not set: accepting any token.',
  );
});
