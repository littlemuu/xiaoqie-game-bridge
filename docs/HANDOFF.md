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
- Abort-aware acknowledged resume authorization: one durable event authorizes
  an exact generation before synchronous commit; deadline, disconnect, audit
  rejection, later stop, and late settlement all leave the latch stopped
- Immediate-destroy overflow admission with explicit socket/timer/response
  counters, tracked handler/audit settlement, and flood/late-shutdown regressions
- Injectable audit sink, hashed identifiers, and recursive credential redaction
- Product `DurableAuditLedger` with canonical version-1 frames, monotonic
  SHA-256 chain, append/data-sync plus strict per-record confirmation and
  independent checkpoint-file syncs, fixed application-owned directory,
  strict object identity checks, and minimal health counters
- Conservative torn-tail recovery that preserves original bytes, appends one
  bounded recovery marker in a new segment, and remains idempotent on restart
- Hard audit limits: 4 KiB record, 8 pending writes, 64 KiB segment, 8 segments,
  2,048 confirmations, 2,048 checkpoints, and 500 ms shutdown drain; no
  eviction, retry loop, upload, or background job
- Worst-case physical-byte reservation before ordinary state changes; confirmed
  tail/evidence loss fails closed, while only bytes lacking both evidence files
  are recoverable
- No generic persistent metadata: undeclared paths, game state, inputs, outputs,
  and regex/blocklist evasions have no ledger field
- Deterministic in-memory mock adapter with movement and block placement
- Fixed process-backed product mock with strict versioned pipe IPC, static
  identity, 64/32 KiB frame/message limits, eight pending calls, bounded
  handshake/call/close, minimal supplied environment, and fail-closed faults
- Source-built narrow Win32 launcher with no committed binary/runtime download;
  real Restricted Token validation, suspended Job assignment/attestation before
  resume, inherited-handle allowlist, and no unrestricted product fallback
- Dedicated Job limits verified from kernel state: kill-on-close, one active
  process, 256 MiB process memory, 192 MiB job memory, 20% CPU hard cap, and no
  breakaway; bounded probes cover child denial, memory/CPU and all setup stages
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
- The parent starts only the fixed native launcher; the helper alone starts the
  fixed `process.execPath` + built worker under a verified Restricted Token and
  Job. The boundary is not a file/network sandbox and remains trusted,
  separately reviewable code.
- The default authorizer only opens sessions for explicit local request
  contexts; omitted or invalid caller context is untrusted for both opening and
  using sessions. The stdio tool cannot accept identity fields and injects its
  frozen local context internally.
- Session ownership is checked before active state, idempotency cache,
  capability, adapter, safety, or close-capacity bypass. A different caller
  cannot read completed responses or wait on in-flight work.
- Sessions and idempotency state are intentionally not persisted.
- Audit events are the only newly persisted state. They are not game saves and
  contain neither mock/real game state nor adapter inputs/outputs. The ledger
  path/segments/format/limits are fixed by product code and are not request,
  MCP, CLI, adapter, or application-specific environment options.
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
npm audit
git diff --check
```

Actual local results on 2026-09-01 with Node.js `v22.23.1` and npm `10.9.8`:

- `npm ci` — passed; 73 packages installed, 74 audited, 0 vulnerabilities
- `npm audit` — passed; 0 vulnerabilities
- `npm run check` — passed
- `npm test` — passed; 8 files, 112 tests passed and one non-Windows gate was
  skipped on Windows. All prior protocol, MCP, operator, audit, safety,
  idempotency and capacity regressions remain green. The new real Windows groups
  cover kernel token/Job attestation before worker entry, a trusted suspended
  candidate process-limit proof, bounded memory and CPU probes, exact inherited
  parent-liveness cleanup of both launcher and worker, six injected setup
  failures, closed-world argv, and fixed containment categories.
- Real stdio contract — passed inside `npm test`; official
  `Client@2.0.0`/`StdioClientTransport` started the built Node entrypoint,
  completed initialize/list/calls, and closed client first then transport
- Real operator contract — passed inside `npm test`; the built CLI observed and
  stopped the same runtime used by the official MCP client, blocked a new MCP
  commit while leaving observe/dry-run/session-close usable, resumed generation
  1, and observed a later MCP stop. A second built product using the same
  isolated test profile verified and continued the ledger, adding another
  acknowledged stop/resume pair. The built CLI produced fixed output and exit
  codes; cleanup left no descriptor or reachable listener.
- `npm run demo` — passed; one idempotency hit, one committed move, safety-stop
  denial, and safe observation were demonstrated
- `npm run build` — passed
- `git diff --check` — passed

Installed versions were `@modelcontextprotocol/server@2.0.0`, dev-only
`@modelcontextprotocol/client@2.0.0`, and `zod@4.5.4`, with one deduplicated Zod
version and no peer conflict. The verification runner used TypeScript `5.9.2`
and Vitest `3.2.7`. Native compilation used the already-installed MinGW-w64
`g++.exe 8.1.0` (`x86_64-posix-seh-rev0`) with C++17, warnings-as-errors, and
static GCC/C++ runtimes. CI discovers the installed MSVC x64 environment via
`vswhere` and compiles the same source with `/W4 /WX`; there is no native npm
dependency, postinstall hook, committed binary, or runtime download.

The verified host reported Windows NT `10.0.22000.0`, 64-bit OS and `x64` Node
process. The trusted helper reported the host process was already in a Job and
successfully established a real nested dedicated Job. Kernel-derived,
closed-world evidence was: restricted token true; dangerous privileges
disabled; privileged groups disabled or deny-only; source-user plus enabled
non-privileged-group restricting policy; medium integrity; membership true;
kill-on-close true; active-process limit 1; process memory 256 MiB; job memory
192 MiB; CPU hard cap 20%; breakaway false. No SID, username, PID, token handle,
path, command line, native error, stack, or secret was emitted by the product
attestation/fault API.

The test-only process-limit proof observed `ERROR_NOT_ENOUGH_QUOTA` while the
real worker was the Job's sole suspended member, confirmed termination of the
exact candidate handle, and re-queried one active/one listed member matching the
original worker before resume. The real worker then attempted the forbidden
child creation and reported its denial; trusted post-attempt accounting showed
zero active/zero listed Job members. The parent-liveness regression closed the
dedicated inherited pipe through a real abnormal parent exit and confirmed the
launcher ended. A complementary direct liveness-channel closure kept the test
observer open while the launcher confirmed contained-worker termination through
its exact process handle. The product uses neither a process-table scan nor a
parent-PID reopen.

Windows audit-file evidence was sampled from a real append-and-sync in a
uniquely named temporary directory. The ledger object was a directory, its
segment was a regular 386-byte file, both were owned by the current user, each
had 11 inherited rules and zero broad Everyone/Authenticated Users/ordinary
Users allow rule, and `AreAccessRulesProtected` was false. The exact temporary
root was path-checked and removed (`TEMP_EVIDENCE_CLEANED=True`). These inherited
ACLs and Node mode requests are explicitly not claimed as a custom
user-exclusive DACL or hostile same-user isolation.

The checked-in workflow has two coherent jobs. Ubuntu is configured for 54
platform-neutral passes and 57 explicit Windows-only skips, including one
non-Windows fail-closed containment test; its demo returns a fixed skip result
instead of using an unrestricted worker. `windows-latest` is configured for the
full suite (locally 112 passed/1 skipped), including native containment, real
named-pipe, CLI, and stdio-child evidence. Both jobs run check, test, demo,
build, audit, and diff-check after `npm ci`.

On this Windows managed host, the final commands used the existing fnm
Node.js `v22.23.1` and npm `10.9.8` explicitly. Vitest, tsx, and approved built
children ran outside the process sandbox because child creation receives
`spawn EPERM` inside it. Every product/operator child used a unique temporary
profile, and suite teardown removed it; the ACL fixture was also precisely
removed. Every fixed probe/launcher settled, and the direct lifecycle checks
found no remaining launcher after normal, failure-injected, or abnormal-parent
paths. No network (except npm install/audit and later GitHub delivery), real
game, desktop application, account, save, existing user file, or host
configuration was accessed. GitHub-hosted CI status is recorded in the Draft PR.

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
- Session, idempotency, safety-latch, and mock-game state still disappear on
  process exit. Only the bounded sanitized audit ledger survives restart.
- Restricted Token + Job Object is not a complete OS sandbox or authorization
  for a real adapter; it does not block every user-readable file or network use.
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
- The audit hash chain and inherited ACL detect/support ordinary same-user
  operation but do not prove hostile-user tamper resistance. There is no
  protected key, external anchor, automatic retention/deletion, or OS sandbox.
- `FileHandle.sync()` is the selected persistence acknowledgement, not a claim
  to bypass hardware caches or survive every physical power-loss model.
- A shutdown deadline cannot cancel a native OS operation already pending, but
  the application stops awaiting/reusing the handle and forbids every later
  append/confirmation/checkpoint continuation. The native operation's only later
  continuation closes the handle when it settles, keyed directly to the abort
  signal even before the final closed-state assignment; process exit is fallback.
- A forced Windows process kill can leave a stale descriptor. Restart then
  fails closed and preserves it; normal EOF/error/close paths clean up, and no
  automatic stale-file deletion is attempted without launch identity evidence.

## Next-ticket gate

Review this stdio/MCP boundary, its real child-process contract evidence, and
remaining cancellation/authentication risks before choosing any next ticket.
Do not infer approval for a real game, remote transport, host configuration, or
desktop integration from this mock-only contract.
