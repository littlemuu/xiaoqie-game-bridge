# Handoff

## Completed

- Node.js 22 + TypeScript project with strict compiler settings
- Versioned strict request/response protocol and stable error codes
- Memory-only, adapter-bound sessions with configurable 15-minute default TTL
  and 60-minute maximum
- Separate observation and per-action capabilities
- Default-deny policy with strict adapter action schemas
- Per-session request idempotency, in-flight duplicate coalescing, and
  conflicting-ID rejection
- Global safety latch plus non-routable local resume control plane
- Injectable audit sink, hashed identifiers, and recursive credential redaction
- Deterministic in-memory mock adapter with movement and block placement
- Acceptance tests, deterministic demo, and Node 22 GitHub Actions workflow
- Architecture, threat model, handoff, and open-question documentation

## Conservative implementation choices

- No transport was added; callers use the in-process API.
- The default authorizer only opens sessions for explicit local request
  contexts; omitted caller context defaults to untrusted remote.
- Sessions and idempotency state are intentionally not persisted.
- The safety latch is process-wide. Resume is absent from the request protocol.
- Game-action capabilities are granular (`game.act.move`,
  `game.act.place_block`) rather than one broad write grant.
- The mock adapter supports only `stone`, `dirt`, and `torch`, with a tiny fixed
  coordinate range.

## Verification

Run from the repository root with Node.js 22:

```bash
npm ci
npm run check
npm test
npm run demo
```

Actual local results on 2026-08-30 with Node.js `v22.23.1` and npm `10.9.8`:

- `npm ci` — passed; 60 packages installed, 61 audited, 0 vulnerabilities
- `npm run check` — passed
- `npm test` — passed; 1 file and 14 tests, including the three review
  regressions
- `npm run demo` — passed; one idempotency hit, one committed move, safety-stop
  denial, and safe observation were demonstrated
- `npm run build` — passed as an additional verification

On this Windows managed host, Vitest and tsx needed to run outside the process
sandbox because their worker/esbuild child processes received `spawn EPERM`
inside it. No network, game, desktop application, or external file was accessed
by the tests or demo. GitHub-hosted CI status is recorded in the Draft PR.

## Known limits

- No real game, save, account, launcher, process, or file is accessed.
- No network transport, MCP server, tunnel, relay, listener, or remote auth is
  implemented.
- Audit and session state disappear on process exit.
- There is no rate limiter or adapter process isolation yet.
- Closed/expired sessions and request-cache entries are not pruned and have no
  capacity limit; a long-lived host can accumulate memory.
- Safety stop blocks writes that have not entered an adapter, but cannot cancel
  an asynchronous adapter action already in flight. The local control plane
  currently exposes resume only, not a direct local stop method.
- `session.open` idempotency is not persisted because it precedes creation of a
  session; session-scoped operations are idempotent as required.

## Suggested next smallest ticket

Before adding a transport, implement a bounded cleanup policy for sessions and
request-cache entries, plus a local stop entry point and an explicit contract
for in-flight action cancellation or non-cancellability. After that hardening,
the next transport ticket should build a **local-only stdio contract test**
around `GameBridge.handle`, still using only the mock adapter.
