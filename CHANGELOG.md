# Changelog

## 0.1.2

### Security

- Removed hardcoded fallback for `SYM_DEMO_TOKEN`. The `/demo/mood`
  endpoint is now disabled entirely (returns 404) unless the env var
  is set. Operators who want the demo endpoint must set a strong random
  token in the deployment environment.

  **Operators upgrading: rotate `SYM_DEMO_TOKEN` in your deployment
  environment if you previously relied on the source-code default.**
  The previous default value is in git history and should be considered
  compromised.

### Added

- README, CHANGELOG, LICENSE for the public release.

## 0.1.1

### Fixed

- **First-writer-wins on duplicate `nodeId`.** When a duplicate-identity
  connection arrives and the existing connection is younger than
  `duplicateRejectWindowMs` (default 5000), reject the newcomer with
  code 4006 instead of replacing the existing connection. The previous
  last-writer-wins semantic encouraged ping-pong loops where two
  processes holding the same identity kicked each other in 1-second
  cycles.
- **Tighter heartbeat: 30s/10s → 10s/5s.** Reduces zombie reap time so
  legitimate restarts aren't blocked by undead predecessors. ~3× more
  heartbeat traffic — at 50 peers ~9 KB/s, negligible.

### Backwards compatibility

- Clients running `@sym-bot/sym 0.3.68+` recognize close codes 4004
  and 4006 as hard stops and don't reconnect.
- Older clients silently retry-and-be-rejected, which still breaks
  the loop just less gracefully.
- `relay-ping`/`relay-pong` wire format unchanged.

## 0.1.0

### Added

- Initial release. WebSocket relay with per-token channel isolation,
  peer directory, broadcast routing, heartbeat liveness detection,
  and an optional `/demo/mood` HTTP endpoint for live demos.
- `Dockerfile` + `render.yaml` for one-click Render deploy.
