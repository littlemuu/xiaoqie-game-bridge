# Handoff

## Completed

- Node.js 22 + TypeScript project with strict compiler settings
- Versioned strict request/response protocol and stable error codes
- Memory-only, adapter-bound sessions with configurable 15-minute default TTL
  and 60-minute maximum, a 64-session hard limit, and deterministic terminal
  retention/sweep; generated ID collisions fail closed without replacement
- Strict out-of-band caller-context snapshots and immutable session ownership:
  values are captured once from own data-property descriptors before
  validation/copy, local uses a process-local owner domain, and the future
  remote seam binds authentication method plus subject; omitted/malformed or
  statefully changing context is denied without throwing
- Domain-separated, length-prefixed full SHA-256 owner keys stored only inside
  sessions, with 32-byte process-secret HMAC caller tags for
  allowed/mismatched audit events; the secret is never persisted or serialized
- Separate observation and per-action capabilities
- Default-deny policy with strict adapter action schemas
- Per-session request idempotency, in-flight duplicate coalescing, and
  conflicting-ID rejection under a 256-entry hard limit
- Atomic global commit-write gate with a default maximum of four in-flight
  writes and reliable `finally` release
- Global safety latch with monotonic stop generations and conservative resume
- Separate Windows named-pipe operator server and narrow status/stop/resume CLI,
  sharing the product bridge, safety latch, and audit sink
- Fail-closed operator-before-MCP startup, bounded shutdown, and exact
  identity/digest-checked descriptor cleanup
- Injectable audit sink, hashed identifiers, and recursive credential redaction
- Deterministic in-memory mock adapter with movement and block placement
- Fixed process-backed product mock with strict versioned pipe IPC, static
  identity, 64/32 KiB frame/message limits, eight pending calls, bounded
  handshake/call/close, minimal supplied environment, and fail-closed faults
- Pure bridge-injected MCP server factory with exactly one
  `game_bridge_request` tool and no resource, prompt, or control-plane surface
- Client-spawned stdio entrypoint with a 64 KiB frame limit, 32 KiB logical
  envelope limit, and default maximum of eight concurrent handlers
- Official MCP client contract tests against the built Node child process
- Acceptance tests, deterministic demo, and Node 22 GitHub Actions workflow
- Architecture, threat model, handoff, and open-question documentation

## Conservative implementation choices

- MCP uses only client-spawned local stdio. The separate operator channel uses
  one same-user Windows named pipe; neither opens TCP or provides remote auth.
- The nested worker uses fixed `process.execPath`, argv, built path/cwd,
  `shell: false`, and pipe-only stdio. It is a same-user process boundary, not
  a proven OS sandbox, and remains trusted separately reviewable code.
- The default authorizer only opens sessions for explicit local request
  contexts; omitted or invalid caller context is untrusted for both opening and
  using sessions. The stdio tool cannot accept identity fields and injects its
  frozen local context internally.
- Session ownership is checked before active state, idempotency cache,
  capability, adapter, safety, or close-capacity bypass. A different caller
  cannot read completed responses or wait on in-flight work.
- Sessions and idempotency state are intentionally not persisted.
- Terminal retention is five minutes by default. Sweep is explicit and
  deterministic; session open invokes it, but no background timer exists.
- Request entries are not evicted. At capacity, an existing ID replays, a new
  ordinary request is refused, and `session.close` uses an idempotent bounded
  bypass without creating a tombstone.
- The safety latch is process-wide. Resume is absent from the request protocol,
  requires the current stop generation, and is refused while any bounded write
  remains in flight. The MCP surface cannot discover or proxy operator control.
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
- `npm test` — passed; 6 files and 70 tests. The original 5 files / 62 tests
  remain green, plus 8 operator groups covering real Windows named pipes,
  built CLI/stdio shared state, generations, in-flight and capacity pressure,
  hostile frames/connections, startup collisions, and exact cleanup
- Real stdio contract — passed inside `npm test`; official
  `Client@2.0.0`/`StdioClientTransport` started the built Node entrypoint,
  completed initialize/list/calls, and closed client first then transport
- Real operator contract — passed inside `npm test`; the built CLI observed and
  stopped the same runtime used by the official MCP client, blocked a new MCP
  commit while leaving observe/dry-run/session-close usable, resumed generation
  1, and observed a later MCP stop. The built CLI produced fixed output and exit
  codes; cleanup left no descriptor or reachable listener.
- `npm run demo` — passed; one idempotency hit, one committed move, safety-stop
  denial, and safe observation were demonstrated
- `npm run build` — passed
- `git diff --check` — passed

Installed versions were `@modelcontextprotocol/server@2.0.0`, dev-only
`@modelcontextprotocol/client@2.0.0`, and `zod@4.5.4`, with one deduplicated Zod
version and no peer conflict. The verification runner used TypeScript `5.9.2`
and Vitest `3.2.7`.

Windows ACL evidence was sampled with `Get-Acl` against live runtime objects.
Both directory and descriptor were owned by the current user, had 6 inherited
allow rules, no broad Everyone/Authenticated Users/ordinary Users allow rule,
and retained SYSTEM/Administrators entries. `AreAccessRulesProtected` was
false, so this is explicitly not claimed as a custom user-exclusive DACL.

On this Windows managed host, Vitest, tsx, and the explicitly approved official
stdio-client child test ran outside the process sandbox because child process
creation receives `spawn EPERM` inside it. The only product child launched in
tests was Node running this repository's built stdio entrypoint. No network,
game, desktop application, account, save, or host configuration was accessed.
GitHub-hosted CI status is recorded in the Draft PR.

## Known limits

- No real game, save, account, launcher, or file is accessed. The only added
  process is the fixed built mock worker.
- No network transport, TCP listener, tunnel, relay, remote authentication, or
  host MCP configuration is implemented. The operator listener is a local
  Windows named pipe only.
- The remote authorizer used by owner-binding tests is test-only. Production
  still has no remote identity provider, credential validation, or persistence.
- Stdio is local process plumbing, not an authorization boundary suitable for a
  remote endpoint.
- Audit and session state disappear on process exit.
- The mock process boundary is not an OS sandbox or authorization for a real adapter.
- Safety stop blocks new writes but does not forcibly cancel an asynchronous
  adapter action already in flight; real adapters may need cooperative
  cancellation.
- MCP cancellation/client disconnect may abandon delivery but does not prove an
  already-entered worker action was cancelled or rolled back.
- `session.open` idempotency is not persisted because it precedes creation of a
  session; session-scoped operations are idempotent as required.
- Windows descriptor modes do not prove a custom user-exclusive DACL. The
  verified boundary remains trusted same-user code; administrator and hostile
  same-user code are residual risks.
- A forced Windows process kill can leave a stale descriptor. Restart then
  fails closed and preserves it; normal EOF/error/close paths clean up, and no
  automatic stale-file deletion is attempted without launch identity evidence.

## Next-ticket gate

Review this stdio/MCP boundary, its real child-process contract evidence, and
remaining cancellation/authentication risks before choosing any next ticket.
Do not infer approval for a real game, remote transport, host configuration, or
desktop integration from this mock-only contract.
