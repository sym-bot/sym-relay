#!/usr/bin/env node
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { SymRelay } = require('./lib/relay');
const { Logger } = require('./lib/logger');

// ── Configuration ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 8080;
const TOKEN = process.env.SYM_RELAY_TOKEN || null;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const log = new Logger(LOG_LEVEL);

// ── HTTP Server ────────────────────────────────────────────────

// Demo endpoint token: REQUIRED via env var. No source-code fallback.
// If unset, the /demo/mood endpoint is disabled entirely (returns 404).
// Operators who want the demo endpoint must set SYM_DEMO_TOKEN to a
// strong random value via the deployment environment (Render dashboard,
// Docker -e, systemd EnvironmentFile, etc).
const DEMO_TOKEN = process.env.SYM_DEMO_TOKEN || null;

const httpServer = http.createServer((req, res) => {
  // CORS for website demo
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connections: relay.connectionCount,
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  // Demo endpoint: broadcast a real mood to all connected peers.
  // Disabled entirely unless SYM_DEMO_TOKEN is set in the environment.
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && urlObj.pathname === '/demo/mood') {
    if (!DEMO_TOKEN) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'demo endpoint disabled (set SYM_DEMO_TOKEN to enable)' }));
      return;
    }
    const token = urlObj.searchParams.get('token');
    if (token !== DEMO_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid token' }));
      return;
    }

    const mood = urlObj.searchParams.get('mood') || 'stressed from long work session';
    const peers = relay.connectionCount;

    // Broadcast as a mood frame from a virtual "demo" peer
    const frame = {
      from: 'demo-000000',
      fromName: 'xmesh-demo',
      payload: {
        type: 'mood',
        from: 'demo-000000',
        fromName: 'xmesh-demo',
        mood,
        timestamp: Date.now(),
      },
    };

    // Send to all connected peers
    for (const [, conn] of relay._connections) {
      try { conn.ws.send(JSON.stringify(frame)); } catch {}
    }

    log.info(`Demo mood broadcast: "${mood}" → ${peers} peer(s)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mood, peers }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── WebSocket Server ───────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });
const CHANNEL_TOKENS = process.env.SYM_RELAY_CHANNELS || null;
const relay = new SymRelay({
  token: CHANNEL_TOKENS ? null : TOKEN,  // single-token fallback if no channels
  channelTokens: CHANNEL_TOKENS,
  logger: log,
  logLevel: LOG_LEVEL,
});

wss.on('connection', (ws) => {
  relay.handleConnection(ws);
});

relay.start();

// ── Start ──────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  log.info(`SYM relay listening on port ${PORT}`, {
    auth: TOKEN ? 'token required' : 'open',
  });
});

// ── Graceful Shutdown ──────────────────────────────────────────

function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  relay.stop();
  wss.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
