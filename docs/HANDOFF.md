# Handoff

## Completed

- Node.js 22 + TypeScript project with strict compiler settings
- Versioned strict request/response protocol and stable error codes
- Memory-only, adapter-bound sessions with configurable 15-minute default TTL
  and 60-minute maximum, a 64-session hard limit, and deterministic terminal
  retention/sweep; generated ID collisions fail closed without replacement
- Separate observation and per-action capabilities
- Default-deny policy with strict adapter action schemas
- Per-session request idempotency, in-flight duplicate coalescing, and
  conflicting-ID rejection under a 256-entry hard limit
- Atomic global commit-write gate with a default maximum of four in-flight
  writes and reliable `finally` release
- Global safety latch plus non-routable local stop/status/resume control plane
- Injectable audit sink, hashed identifiers, and recursive credential redaction
- Deterministic in-memory mock adapter with movement and block placement
- Pure bridge-injected MCP server factory with exactly one
  `game_bridge_request` tool and no resource, prompt, or control-plane surface
- Client-spawned stdio entrypoint with a 64 KiB frame limit, 32 KiB logical
  envelope limit, and default maximum of eight concurrent handlers
- Official MCP client contract tests against the built Node child process
- Acceptance tests, deterministic demo, and Node 22 GitHub Actions workflow
- Architecture, threat model, handoff, and open-question documentation

## Conservative implementation choices

- The only transport is client-spawned local stdio. It opens no listener or
  network endpoint and is not remote authentication.
- The default authorizer only opens sessions for explicit local request
  contexts; omitted caller context defaults to untrusted remote. The stdio tool
  cannot accept identity fields and injects its frozen local context internally.
- Sessions and idempotency state are intentionally not persisted.
- Terminal retention is five minutes by default. Sweep is explicit and
  deterministic; session open invokes it, but no background timer exists.
- Request entries are not evicted. At capacity, an existing ID replays, a new
  ordinary request is refused, and `session.close` uses an idempotent bounded
  bypass without creating a tombstone.
- The safety latch is process-wide. Resume is absent from the request protocol
  and refused while any bounded write remains in flight. The MCP surface does
  not expose the local status/resume control object.
- MCP JSON-RPC IDs are independent of bridge request IDs. The wrapper preserves
  bridge IDs and never retries; transport-level refusals do not populate the
  core idempotency cache.
- Handler permits release in `finally`. Cancellation or disconnect does not
  claim to cancel an adapter write that already entered the core.
- Game-action capabilities are granular (`game.act.move`,
  `game.act.place_block`) rather than one broad write grant.
- The mock adapter supports only `stone`, `dirt`, and `torch`, with a tiny fixed
  coordinate range.
- `@modelcontextprotocol/server` and the dev-only client are both locked to
  `2.0.0` from the official MIT-licensed TypeScript SDK repository. Existing
  Zod was minimally upgraded to `4.5.4` because SDK v2 tool registration
  requires the public Standard JSON Schema interface; the bridge schemas remain
  the single contract source.

## Verification

Run from the repository root with Node.js 22:

```bash
npm ci
npm run check
npm test
npm run demo
npm run build
git diff --check
```

Actual local results on 2026-08-30 with Node.js `v22.23.1` and npm `10.9.8`:

- `npm ci` — passed; 73 packages installed, 74 audited, 0 vulnerabilities
- `npm audit` — passed; 0 vulnerabilities
- `npm run check` — passed
- `npm test` — passed; 3 files and 29 tests: the existing 21 core/hardening
  tests plus 8 MCP tests
- Real stdio contract — passed inside `npm test`; official
  `Client@2.0.0`/`StdioClientTransport` started the built Node entrypoint,
  completed initialize/list/calls, and closed client first then transport
- `npm run demo` — passed; one idempotency hit, one committed move, safety-stop
  denial, and safe observation were demonstrated
- `npm run build` — passed
- `git diff --check` — passed

Installed versions were `@modelcontextprotocol/server@2.0.0`, dev-only
`@modelcontextprotocol/client@2.0.0`, and `zod@4.5.4`, with one deduplicated Zod
version and no peer conflict.

On this Windows managed host, Vitest, tsx, and the explicitly approved official
stdio-client child test ran outside the process sandbox because child process
creation receives `spawn EPERM` inside it. The only product child launched in
tests was Node running this repository's built stdio entrypoint. No network,
game, desktop application, account, save, or host configuration was accessed.
GitHub-hosted CI status is recorded in the Draft PR.

## Known limits

- No real game, save, account, launcher, process, or file is accessed.
- No network transport, tunnel, relay, listener, remote authentication, or host
  MCP configuration is implemented.
- Stdio is local process plumbing, not an authorization boundary suitable for a
  remote endpoint.
- Audit and session state disappear on process exit.
- There is no rate limiter or adapter process isolation yet.
- Safety stop blocks new writes but does not forcibly cancel an asynchronous
  adapter action already in flight; real adapters may need cooperative
  cancellation.
- MCP cancellation/client disconnect may abandon delivery but does not prove an
  already-entered core/adapter write was cancelled.
- `session.open` idempotency is not persisted because it precedes creation of a
  session; session-scoped operations are idempotent as required.

## Next-ticket gate

Review this stdio/MCP boundary, its real child-process contract evidence, and
remaining cancellation/authentication risks before choosing any next ticket.
Do not infer approval for a real game, remote transport, host configuration, or
desktop integration from this mock-only contract.
