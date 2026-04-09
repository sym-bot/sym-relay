'use strict';

const { Logger } = require('./logger');

/**
 * SymRelay — a peer node in the MMP mesh.
 *
 * The relay is a full mesh participant with its own identity. It forwards
 * frames between authenticated nodes without inspecting payloads (dumb
 * transport), but participates in peer gossip — storing wake channels
 * and peer metadata so that newly-connecting nodes can learn about
 * sleeping peers they've never met.
 *
 * All coupling decisions remain on-device. The relay never evaluates
 * cognitive state.
 *
 * MMP v0.2.0 Protocol:
 *   1. Client connects via WebSocket
 *   2. Client sends: { type: 'relay-auth', nodeId, name, token?, wakeChannel? }
 *   3. Relay validates, registers, updates peer directory
 *   4. Relay sends: { type: 'relay-peers', peers: [{ nodeId, name, wakeChannel?, offline? }] }
 *      — includes disconnected peers with wake channels (gossip)
 *   5. Relay notifies others: { type: 'relay-peer-joined', nodeId, name }
 *   6. Client sends: { to?: nodeId, payload: <MMP frame> }
 *   7. Relay forwards: { from: nodeId, fromName: name, payload: <MMP frame> }
 *   8. Relay intercepts peer-info and wake-channel payloads to update directory
 *   9. On disconnect: { type: 'relay-peer-left', nodeId, name }
 */
class SymRelay {

  constructor(opts = {}) {
    this._token = opts.token || null;
    this._log = opts.logger || new Logger(opts.logLevel || 'info');
    // Heartbeat tightened from 30s/10s → 10s/5s so legitimate restarts
    // (which announce themselves with a fresh connection) aren't blocked
    // by stale zombie registrations for long. Trade-off is ~3× heartbeat
    // traffic — at ~50 peers and 30-byte ping/pong frames that's ~9 KB/s
    // total, negligible vs CMB payload sizes.
    this._pingInterval = opts.pingInterval || 10000;
    this._pingTimeout = opts.pingTimeout || 5000;
    // First-writer-wins window: when a duplicate-nodeId connection arrives
    // and the existing connection is younger than this, reject the newcomer
    // instead of replacing the existing one. Prevents the duplicate-identity
    // ping-pong loop documented in @sym-bot/sym 0.3.68.
    this._duplicateRejectWindowMs = opts.duplicateRejectWindowMs || 5000;

    /**
     * Channel tokens — maps token → channel name for isolation.
     * Connections with different tokens are in separate channels.
     * Format: "token1:channel1,token2:channel2" or single token (backward compat).
     */
    this._channelTokens = new Map();
    if (opts.channelTokens) {
      for (const entry of opts.channelTokens.split(',')) {
        const [tok, ch] = entry.trim().split(':');
        if (tok && ch) this._channelTokens.set(tok.trim(), ch.trim());
      }
    }

    /** Active WebSocket connections. nodeId → ConnectionState */
    this._connections = new Map();

    /**
     * Peer directory — retained across disconnects for gossip.
     * nodeId → { name: string, wakeChannel?: WakeChannel, lastSeen: number }
     *
     * This is what makes the relay a gossip hub: when a new node connects,
     * the relay shares what it knows about peers the new node has never met.
     */
    this._peerDirectory = new Map();
    this._peerDirectoryTTL = opts.peerDirectoryTTL || 7 * 24 * 60 * 60 * 1000; // 7 days

    this._pingTimer = null;
  }

  // ── Public API ──────────────────────────────────────────────

  get connectionCount() {
    return this._connections.size;
  }

  get directorySize() {
    return this._peerDirectory.size;
  }

  start() {
    this._pingTimer = setInterval(() => this._heartbeat(), this._pingInterval);
  }

  stop() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    for (const [, conn] of this._connections) {
      conn.ws.close(1001, 'Server shutting down');
    }
    this._connections.clear();
  }

  /**
   * Handle a new WebSocket connection. Called by the server on 'connection'.
   */
  handleConnection(ws) {
    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        this._log.warn('Auth timeout — closing connection');
        ws.close(4001, 'Auth timeout');
      }
    }, 10000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch {
        this._log.warn('Invalid JSON received');
        return;
      }

      if (!authenticated) {
        authenticated = this._authenticate(ws, msg, authTimeout);
        return;
      }

      this._onMessage(msg, ws);
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this._removeBySocket(ws);
    });

    ws.on('error', (err) => {
      this._log.warn(`WebSocket error: ${err.message}`);
    });
  }

  // ── Authentication ─────────────────────────────────────────

  _authenticate(ws, msg, authTimeout) {
    if (msg.type !== 'relay-auth' || !msg.nodeId || !msg.name) {
      this._log.warn('Invalid auth message', { type: msg.type });
      ws.close(4002, 'Invalid auth');
      clearTimeout(authTimeout);
      return false;
    }

    // Channel-based auth: if channelTokens configured, token must match a channel.
    // Otherwise fall back to single-token auth (backward compat).
    let channel = 'default';
    if (this._channelTokens.size > 0) {
      const ch = this._channelTokens.get(msg.token);
      if (!ch) {
        this._log.warn('Auth rejected — token not in any channel', { name: msg.name });
        ws.send(JSON.stringify({ type: 'relay-error', message: 'Invalid token' }));
        ws.close(4003, 'Invalid token');
        clearTimeout(authTimeout);
        return false;
      }
      channel = ch;
    } else if (this._token && msg.token !== this._token) {
      this._log.warn('Auth rejected — invalid token', { name: msg.name });
      ws.send(JSON.stringify({ type: 'relay-error', message: 'Invalid token' }));
      ws.close(4003, 'Invalid token');
      clearTimeout(authTimeout);
      return false;
    }

    // MMP identity invariant: nodeId is bound to a keypair. Two simultaneous
    // holders is an error condition (orphan, restart race, or impersonation),
    // not something to silently work around.
    //
    // First-writer-wins: if an existing connection is fresh, the legitimate
    // holder is the one already connected. Reject the newcomer with code
    // 4006. Clients running @sym-bot/sym 0.3.68+ recognise 4006 as a hard
    // stop and will not reconnect, breaking the ping-pong loop deterministi-
    // cally. Older clients without 4006 handling will retry with backoff,
    // but their retries will keep being rejected as long as the existing
    // connection stays alive — also breaking the loop, just less gracefully.
    //
    // If the existing connection is stale (>= duplicateRejectWindowMs),
    // assume it's a zombie that hasn't been reaped by the heartbeat yet
    // and fall through to the original replacement path.
    if (this._connections.has(msg.nodeId)) {
      const existing = this._connections.get(msg.nodeId);
      const existingAgeMs = Date.now() - existing.connectedAt;

      if (existingAgeMs < this._duplicateRejectWindowMs) {
        this._log.warn('Duplicate nodeId rejected — existing connection too fresh', {
          name: msg.name,
          nodeId: msg.nodeId.slice(0, 8),
          existingAgeMs,
        });
        try {
          ws.send(JSON.stringify({ type: 'relay-error', message: 'duplicate identity — existing connection too fresh' }));
        } catch {}
        ws.close(4006, 'Existing connection too fresh — duplicate identity rejected');
        return;
      }

      this._log.info('Duplicate nodeId — replacing stale connection', { name: msg.name, existingAgeMs });
      this._connections.delete(msg.nodeId);
      existing.ws.close(4004, 'Replaced by new connection');
    }

    clearTimeout(authTimeout);

    // Register active connection with channel
    this._connections.set(msg.nodeId, {
      ws,
      nodeId: msg.nodeId,
      name: msg.name,
      channel,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      alive: true,
    });

    // Update peer directory
    this._updateDirectory(msg.nodeId, msg.name, msg.wakeChannel, channel);

    this._log.info(`Peer authenticated: ${msg.name} (${msg.nodeId.slice(0, 8)})`, {
      connections: this._connections.size,
      directory: this._peerDirectory.size,
    });

    // Send peer list with gossip (connected + offline peers with wake channels)
    ws.send(JSON.stringify({
      type: 'relay-peers',
      peers: this._buildPeerList(msg.nodeId),
    }));

    // Notify existing peers
    this._broadcast(msg.nodeId, {
      type: 'relay-peer-joined',
      nodeId: msg.nodeId,
      name: msg.name,
    });

    return true;
  }

  // ── Peer Directory ──────────────────────────────────────────

  /**
   * Update the peer directory with the latest information about a node.
   * The directory survives disconnects — this is the gossip state.
   */
  _updateDirectory(nodeId, name, wakeChannel, channel) {
    const existing = this._peerDirectory.get(nodeId) || {};
    const entry = {
      ...existing,
      name: name || existing.name,
      channel: channel || existing.channel || 'default',
      lastSeen: Date.now(),
    };
    if (wakeChannel && this._isValidWakeChannel(wakeChannel)) {
      entry.wakeChannel = wakeChannel;
    }
    this._peerDirectory.set(nodeId, entry);
  }

  /**
   * Validate wake channel structure.
   */
  _isValidWakeChannel(wc) {
    return wc
      && typeof wc.platform === 'string'
      && wc.platform !== 'none'
      && typeof wc.token === 'string'
      && wc.token.length > 0;
  }

  /**
   * Build the peer list for a newly-connected node.
   * Includes connected peers AND offline peers with wake channels (gossip).
   */
  _buildPeerList(excludeNodeId) {
    const requester = this._connections.get(excludeNodeId);
    const requesterChannel = requester?.channel || 'default';
    const peers = [];
    const seen = new Set();

    // Connected peers — same channel only
    for (const [id, conn] of this._connections) {
      if (id === excludeNodeId) continue;
      if (conn.channel !== requesterChannel) continue;
      seen.add(id);
      const dir = this._peerDirectory.get(id);
      const entry = { nodeId: conn.nodeId, name: conn.name };
      if (dir?.wakeChannel) entry.wakeChannel = dir.wakeChannel;
      peers.push(entry);
    }

    // Offline peers with wake channels — same channel only
    for (const [id, dir] of this._peerDirectory) {
      if (id === excludeNodeId || seen.has(id)) continue;
      if (!dir.wakeChannel || !dir.name) continue;
      if (dir.channel && dir.channel !== requesterChannel) continue;
      peers.push({
        nodeId: id,
        name: dir.name,
        wakeChannel: dir.wakeChannel,
        offline: true,
      });
    }

    return peers;
  }

  // ── Message Routing ────────────────────────────────────────

  _onMessage(msg, ws) {
    const sender = this._findBySocket(ws);
    if (!sender) {
      // Client is sending on an unregistered socket — relay may have restarted
      // while the client's TCP connection survived (e.g. Render proxy keepalive).
      // Tell client to re-authenticate. Rate-limit: one per socket.
      if (!ws._reauthSent) {
        ws._reauthSent = true;
        try { ws.send(JSON.stringify({ type: 'relay-reauth' })); } catch {}
        this._log.info('Unregistered socket sent message — requested re-auth');
      }
      return;
    }

    sender.lastSeen = Date.now();

    // Relay control messages
    if (msg.type === 'relay-pong') {
      sender.alive = true;
      return;
    }

    // Intercept peer metadata from payloads (relay participates in gossip)
    this._interceptPeerMetadata(sender, msg);

    // Forward to specific peer or broadcast (channel-isolated)
    if (msg.to) {
      this._sendTo(msg.to, {
        from: sender.nodeId,
        fromName: sender.name,
        payload: msg.payload,
      }, sender.channel);
    } else if (msg.payload) {
      this._broadcast(sender.nodeId, {
        from: sender.nodeId,
        fromName: sender.name,
        payload: msg.payload,
      });
    }
  }

  /**
   * Intercept MMP frames that carry peer metadata to update the directory.
   * The relay doesn't inspect cognitive payloads — only peer discovery metadata.
   */
  _interceptPeerMetadata(sender, msg) {
    const payload = msg.payload;
    if (!payload || typeof payload !== 'object') return;

    // peer-info gossip frame
    if (payload.type === 'peer-info' && Array.isArray(payload.peers)) {
      for (const p of payload.peers) {
        if (!p.nodeId || p.nodeId === sender.nodeId) continue;
        if (p.wakeChannel && this._isValidWakeChannel(p.wakeChannel)) {
          this._updateDirectory(p.nodeId, p.name, p.wakeChannel);
        }
      }
    }

    // wake-channel frame (direct declaration from sender)
    if (payload.type === 'wake-channel' && this._isValidWakeChannel(payload)) {
      this._updateDirectory(sender.nodeId, sender.name, {
        platform: payload.platform,
        token: payload.token,
        environment: payload.environment,
      });
      this._log.info(`Wake channel stored: ${sender.name} (${payload.platform})`);
    }
  }

  // ── Transport ──────────────────────────────────────────────

  _sendTo(targetNodeId, envelope, senderChannel) {
    const conn = this._connections.get(targetNodeId);
    if (!conn) return;
    // Channel isolation: cannot send across channels
    if (senderChannel && conn.channel !== senderChannel) return;
    try {
      conn.ws.send(JSON.stringify(envelope));
    } catch (err) {
      this._log.warn(`Send failed to ${conn.name}: ${err.message}`);
    }
  }

  _broadcast(excludeNodeId, envelope) {
    const sender = this._connections.get(excludeNodeId);
    const senderChannel = sender?.channel || 'default';
    const data = JSON.stringify(envelope);
    for (const [id, conn] of this._connections) {
      if (id === excludeNodeId) continue;
      // Channel isolation: only broadcast to same channel
      if (conn.channel !== senderChannel) continue;
      try {
        conn.ws.send(data);
      } catch (err) {
        this._log.warn(`Broadcast failed to ${conn.name}: ${err.message}`);
      }
    }
  }

  // ── Connection Management ──────────────────────────────────

  _findBySocket(ws) {
    for (const [, conn] of this._connections) {
      if (conn.ws === ws) return conn;
    }
    return null;
  }

  _removeBySocket(ws) {
    const conn = this._findBySocket(ws);
    if (conn) this._removeConnection(conn.nodeId);
  }

  _removeConnection(nodeId) {
    const conn = this._connections.get(nodeId);
    if (!conn) return;

    this._connections.delete(nodeId);

    // Update directory lastSeen on disconnect (keeps the entry alive for gossip)
    const dir = this._peerDirectory.get(nodeId);
    if (dir) dir.lastSeen = Date.now();

    this._log.info(`Peer disconnected: ${conn.name} (${nodeId.slice(0, 8)})`, {
      connections: this._connections.size,
    });

    this._broadcast(nodeId, {
      type: 'relay-peer-left',
      nodeId: conn.nodeId,
      name: conn.name,
    });
  }

  // ── Heartbeat ──────────────────────────────────────────────

  _heartbeat() {
    // Expire stale directory entries (disconnected peers beyond TTL)
    const now = Date.now();
    for (const [nodeId, dir] of this._peerDirectory) {
      if (!this._connections.has(nodeId) && now - dir.lastSeen > this._peerDirectoryTTL) {
        this._peerDirectory.delete(nodeId);
        this._log.info(`Directory expired: ${dir.name} (${nodeId.slice(0, 8)})`);
      }
    }

    // Ping active connections
    for (const [nodeId, conn] of this._connections) {
      if (!conn.alive) {
        this._log.info(`Heartbeat timeout: ${conn.name}`);
        conn.ws.close(4005, 'Heartbeat timeout');
        this._removeConnection(nodeId);
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.send(JSON.stringify({ type: 'relay-ping' }));
      } catch {
        this._removeConnection(nodeId);
      }
    }
  }
}

module.exports = { SymRelay };
