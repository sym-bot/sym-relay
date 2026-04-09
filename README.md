# sym-relay

> WebSocket relay for the [SYM mesh](https://sym.bot). Cross-network transport for cognitive coupling between MMP peer nodes.

`sym-relay` is the optional internet-scale transport for the Mesh Memory Protocol. Two SYM peers on the same LAN discover each other directly via Bonjour mDNS and don't need a relay at all. The relay only matters when peers are on different networks (different offices, home ↔ coffee shop, mobile ↔ desktop, etc).

This is the reference implementation. It's small (<5 KB of routing logic), depends only on `ws`, runs comfortably on a Render free dyno, and supports per-token channel isolation so a single deployment can host multiple isolated meshes.

See:
- **MMP spec**: [sym.bot/spec/mmp](https://sym.bot/spec/mmp) (transport semantics in §4-5)
- **SVAF paper**: [arxiv.org/abs/2604.03955](https://arxiv.org/abs/2604.03955)
- **Reference client SDK**: [`@sym-bot/sym`](https://www.npmjs.com/package/@sym-bot/sym)
- **Claude Code MCP bridge**: [`@sym-bot/mesh-channel`](https://www.npmjs.com/package/@sym-bot/mesh-channel)

## Run locally

```bash
git clone https://github.com/sym-bot/sym-relay
cd sym-relay
npm install
SYM_RELAY_TOKEN=your-shared-secret PORT=8080 npm start
```

That's the minimum. The relay listens on `:8080` for WebSocket connections at `ws://localhost:8080` and HTTP at `http://localhost:8080/health`.

Point clients at it by setting `SYM_RELAY_URL=ws://localhost:8080` and `SYM_RELAY_TOKEN=your-shared-secret` in their environment. All clients sharing the same token are on the same channel.

## Deploy on Render

A `render.yaml` is included. Connect this repo to Render as a Web Service, then set `SYM_RELAY_TOKEN` in the Render dashboard (it's marked `sync: false` so it's never written to the file). Render auto-deploys on push to `main`.

The free dyno is enough for ~50 concurrent peers and idle-spins-down after 15 minutes (which is fine — clients reconnect on demand).

For other hosts: a `Dockerfile` is included. Standard `docker build && docker run -p 8080:8080 -e SYM_RELAY_TOKEN=...` works.

## Channel isolation

A single relay can host multiple independent meshes via per-token channels. Set `SYM_RELAY_CHANNELS` to a comma-separated mapping:

```
SYM_RELAY_CHANNELS="token-prod:prod,token-staging:staging,token-demo:demo"
```

Clients authenticating with `token-prod` only see other clients on the `prod` channel. Clients with `token-staging` only see `staging`. The channels are fully isolated — no cross-channel routing, no peer-list leakage.

If `SYM_RELAY_CHANNELS` is unset and `SYM_RELAY_TOKEN` is set, the relay falls back to single-channel mode where every authenticated client is on the default channel.

If neither is set, the relay starts in **open mode** where authentication is skipped entirely. Open mode is for local development only. Don't deploy a public relay without authentication.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check. Returns `{ status, connections, uptime }`. |
| `GET` | `/demo/mood` | Optional broadcast endpoint for live demos. **Disabled by default** — only active if `SYM_DEMO_TOKEN` is set in the environment. |
| `WS`  | `/` | WebSocket peer connection. See protocol below. |

## Protocol (MMP transport, §4)

After WebSocket connection:

1. **Client sends auth frame:**
   ```json
   {
     "type": "relay-auth",
     "nodeId": "<uuid-v7>",
     "name": "<display-name>",
     "token": "<channel-token>",
     "wakeChannel": { "platform": "apns", "token": "..." }   // optional
   }
   ```

2. **Server replies with peer list:**
   ```json
   { "type": "relay-peers", "peers": [{ "nodeId", "name", "wakeChannel" }] }
   ```

3. **Server broadcasts presence to others:**
   ```json
   { "type": "relay-peer-joined", "nodeId", "name" }
   ```

4. **Heartbeat:** server sends `{ "type": "relay-ping" }` every 10s; client responds `{ "type": "relay-pong" }`. Connections that miss two consecutive pongs are closed with code 4005.

5. **CMB / message routing:** clients send framed messages with `{ from, to, payload }`. The relay routes by `to` (single peer) or broadcasts (no `to`) within the channel. Payloads are opaque to the relay — encryption and SVAF gating happen at the SymNode layer.

6. **Identity safety:** if a client tries to register a `nodeId` that's already held by a fresh connection (< 5s old), the relay rejects with code 4006 ("first-writer-wins"). Clients running `@sym-bot/sym >= 0.3.68` recognize 4004 and 4006 as hard stops and don't reconnect, which prevents duplicate-identity ping-pong loops.

## Close codes

| Code | Meaning |
|---|---|
| 4001 | Auth timeout (client never sent `relay-auth`) |
| 4002 | Auth invalid (missing nodeId or name) |
| 4003 | Invalid token (not in any channel) |
| 4004 | Replaced by new connection (your nodeId was claimed by a fresh peer) |
| 4005 | Heartbeat timeout |
| 4006 | Duplicate identity rejected (existing connection too fresh) |

## Security notes

- **Token rotation**: if you suspect a token leak, change `SYM_RELAY_TOKEN` (or rotate the relevant entry in `SYM_RELAY_CHANNELS`) and restart. All clients using the old token will be disconnected.
- **Demo endpoint is opt-in**: `SYM_DEMO_TOKEN` defaults to unset; without it the `/demo/mood` route returns 404.
- **No persistence**: the relay is pure routing. CMBs flow through; nothing is stored. If you need an audit trail, run it at the SymNode layer (`@sym-bot/sym` ships memory persistence).
- **HTTPS / WSS in production**: terminate TLS at the load balancer (Render does this automatically). The relay itself speaks plain WS.

## License

Apache 2.0 — SYM.BOT Ltd
