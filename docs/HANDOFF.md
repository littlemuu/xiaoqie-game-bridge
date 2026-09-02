# Handoff

## Completed

- Adapter Contract v2 with strict input/output schemas, read/preview/write
  effect metadata, dry-run semantics, required-capability sets, fixed result
  byte limits, resource-serial declarations, adapter error namespaces,
  revision requirements, and future reconciliation metadata
- Registration-time validation, snapshotting, and freezing of adapter identity,
  observation, actions, schemas, capabilities, limits, and metadata; runtime
  replacement of the source manifest cannot expand the registered surface
- Positive allowlist for JSON-Schema-round-trippable Zod nodes/checks/options;
  refinements/transforms/codecs, overwrite/trim, coerce, user `when`, and every
  unknown definition are rejected; the rebuilt validator is hidden and frozen
- Zero-action read-only adapters, optional revision providers unless demanded
  by an action, and parallel/serial/resource-serial observation scheduling
- Pure-JSON `bridge.describe` catalog with input/output JSON Schema and no Zod
  instances, functions, or arbitrary adapter objects
- Fixed 1 KiB schema-scalar, 16 KiB schema-snapshot, and 128 KiB adapter-catalog
  UTF-8 limits enforced during registration
- Explicit trusted mock grant provider with fixed tiny-world scope, actual
  requested/profile/manifest intersection, TTL cap, session action budget, and
  per-action budgets; owner binding remains independent from authorization
- Closed-world runtime grant snapshot before side effects: bounded integer TTL,
  adapter-namespaced scope, deduplicated request/manifest capabilities, and
  write-action-aligned budgets with no extra fields
- Monotonic mock `stateRevision`, observation/preview revision output,
  required `expectedRevision` on mock commits, and one increment per successful
  write only
- No-queue resource-level single-write scheduler composed with the existing
  global safety write gate; stop is checked before and during atomic admission
- Closed runtime/adapter/audit/safety health model returned by operator status
  from one coherent snapshot and printed by the CLI without paths, endpoints,
  tokens, PIDs, exception text, audit contents, or adapter payloads
- Runtime health capture maps malformed/throwing/thenable adapter health to
  `faulted` and malformed audit health/counts to `corrupt` before commit admission
- Pre-response adapter output schema/serialization/byte-limit validation,
  allowlisted adapter rejection codes, explicit dispatch-phase classification,
  and conservative cached `OUTCOME_UNKNOWN` without retry
- MCP preserves validated catalog/result fields and types; audit-oriented
  key-name redaction is confined to audit events
- `package.json` as the MCP metadata version source, `PROTOCOL_VERSION` as the
  bridge protocol source, shared transient canonical JSON, and explicitly
  separate versioned audit-frame canonical encoding

- `0.1.0-rc.1` single-source release version with lock/manifest/SBOM checks
- Deterministic, normalized source-build bundle with an exact file allowlist
- SHA-256 list, CycloneDX 1.6 JSON SBOM, versioned release manifest and unsigned
  in-toto/SLSA provenance subject bound to the bundle digest
- Full-SHA-pinned Actions, read-only PR/push permissions and a protected,
  annotated-tag-only minimal-write prerelease workflow
- Two independent local clean-clone/offline builds with byte-identical digest
  enforcement and exact temporary cleanup
- Closed-world Windows JSON/Markdown evidence with explicit elevation, skip,
  failure, unknown and containment/cleanup status
- Checkout-derived provenance identity with expected commit/ref used only as
  assertions, including annotated-tag peel and PR-ref resolution checks
- Versioned exact full-suite inventory that prevents empty, partial, duplicate
  or targeted Vitest output from becoming non-elevated Windows evidence
- Separate read-only tag build and minimal credential-bearing publish jobs;
  dependency installation and general project execution never receive release
  write/OIDC credentials
- Closed parsing of every workflow `uses:` key, including rejection of quoted,
  expression, Docker, floating and otherwise unrecognized forms

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

- The product grant provider recognizes only the fixed local `mock-world`
  profile and `tiny-world-v1` scope. Test-only providers exercise the injection
  seam but do not add production remote identity or broader grants.
- Action budget counts commit attempts only after health, safety, resource and
  revision admission. A `not-dispatched` runtime result rolls back the
  reservation. Dry-run, pre-dispatch rejection and replay do not charge;
  worker rejection and outcome unknown charge once because dispatch occurred.
- Quiescing rejects new session opens and commit writes and retains stop/close/read.
  Session-open commit health is checked again synchronously after an asynchronous
  grant settles and before audit reservation or insertion.
- The effect/mode matrix rejects commit for read/preview actions before adapter
  dispatch. Non-write actions must declare `writeConcurrency: none`; only write
  actions can claim resource scheduling or enter commit safety and budgets.
- Schema registration captures an immutable own-data declarative AST before
  rebuilding a trusted emitter input. Custom Zod emitters, live graph accessors,
  proxy failures, oversized scalar/snapshot/catalog data, and malformed manifest
  string arrays fail closed. Grant capability length is captured once from its
  own data descriptor rather than repeatedly reading live array state.
  Product shutdown separately bounds mutation settlement, closes the adapter,
  then always invokes the ledger's own bounded drain/abort even on adapter error.
- Invalid output after a write is classified with a fixed output error and
  outcome-unknown phase, then faults later commit health. The original output
  is never echoed or audited.
- `OUTCOME_UNKNOWN` is a narrow forward interface, not a journal. There is no
  operation database, persistent operation ID, reconciliation, auto-retry, or
  cross-restart exactly-once claim in this ticket.

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
npm run release:workflow-policy
npm run release:reproducible
npm run release:build
npm run release:verify
git diff --check
```

Actual local results on 2026-09-01 with Node.js `v22.23.1` and npm `10.9.8`:

- `npm ci` — passed; 73 packages installed, 74 audited, 0 vulnerabilities
- `npm audit` — passed; 0 vulnerabilities
- `npm run check` — passed
- `npm test` — passed; 10 files, 158 tests passed and 2 explicitly inapplicable
  Windows gates skipped (160 registered assertions) in 40.05 s. The first full
  run hit only the existing 5 s release-clone and 10 s ledger-prefix timeouts;
  both passed unchanged in isolation (2.83 s / 7.72 s), then the final default
  full run passed. All prior
  protocol, MCP, operator, audit, safety, idempotency, capacity and containment
  regressions remain green. Adapter Contract v2 coverage now includes the Zod
  positive allowlist with own-data AST capture, trusted emitter reconstruction,
  isolated metadata and finite numeric literals, dense manifest string arrays,
  async grant final admission, the closed effect/mode/scheduling matrix,
  malformed runtime grants before side effects, closed-world runtime health,
  schema/catalog byte limits, descriptor-captured grant arrays, MCP catalog/result
  type preservation, separate mutation/audit shutdown phases, adapter-close
  failure cleanup, immutable catalogs, revisions, budgets, output validation,
  and outcome-unknown handling.
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
zero active/zero listed Job members. Both parent-liveness regressions buffer an
unread partial IPC frame for a worker that never consumes stdin. A real abnormal
parent exit proves the independent stderr liveness pipe still breaks and the
launcher ends. A complementary direct liveness-channel closure keeps the test
observer open while the launcher confirms contained-worker termination through
its exact process handle. The product uses neither a process-table scan nor a
parent-PID reopen. The launcher validates the inherited stderr write endpoint,
writes fixed one-byte pulses through an exact non-inheritable duplicate, and
passes only stdin, stdout, and NUL stderr to the worker. This uses the Win32
standard-handle contract shared by MSVCRT and UCRT rather than relying on extra
CRT file descriptors or the state of the stdin buffer.

GitHub-hosted Windows runners are elevated administrators, while the product
intentionally rejects every elevated host. The Windows workflow therefore
compiles both helpers with MSVC/UCRT, explicitly verifies the runner's elevated
role, and runs the product binary's no-output/exit-41 pre-worker rejection
regression. It does not claim a hosted happy-path containment run. The complete
non-elevated Windows suite remains local evidence until a non-elevated dedicated
runner is available; no account, ACL, UAC, or product-policy mutation is used to
manufacture a hosted pass.

Windows audit-file evidence was sampled from a real append-and-sync in a
uniquely named temporary directory. The ledger object was a directory, its
segment was a regular 386-byte file, both were owned by the current user, each
had 11 inherited rules and zero broad Everyone/Authenticated Users/ordinary
Users allow rule, and `AreAccessRulesProtected` was false. The exact temporary
root was path-checked and removed (`TEMP_EVIDENCE_CLEANED=True`). These inherited
ACLs and Node mode requests are explicitly not claimed as a custom
user-exclusive DACL or hostile same-user isolation.

The checked-in workflow has two deliberately different jobs. Ubuntu currently
runs 54 platform-neutral passes with 61 explicit Windows-only skips; its demo
returns a fixed skip result instead of using an unrestricted worker. Elevated
`windows-latest` runs check, confirms its administrator role, verifies only the
product's silent exit-41 pre-worker rejection, then runs the MSVC/UCRT build,
audit, and diff-check. It does not run or claim the non-elevated allow path,
named-pipe/operator, process-adapter, MCP stdio, CLI, lifecycle, or demo suite.
Those remain local non-elevated Windows evidence until a suitable dedicated
runner exists. The final Node 22 run for Adapter Contract v2 passed all 10 files
with 153 passed/2 explicitly inapplicable skips in 46.23 s; the exact inventory
now includes `adapter-contract-v2.test.ts`, so partial or stale nine-file output
cannot become non-elevated Windows evidence.

On this Windows managed host, the final commands used an official
SHA-256-verified temporary Node.js `v22.23.1` archive and npm `10.9.8`
explicitly; the archive was removed after acceptance. Vitest, tsx, and approved built
children ran outside the process sandbox because child creation receives
`spawn EPERM` inside it. Every product/operator child used a unique temporary
profile, and suite teardown removed it; the ACL fixture was also precisely
removed. Every fixed probe/launcher settled, and the direct lifecycle checks
found no remaining launcher after normal, failure-injected, or abnormal-parent
paths. No network (except npm install/audit and later GitHub delivery), real
game, desktop application, account, save, existing user file, or host
configuration was accessed. GitHub-hosted CI status is recorded in the Draft PR.

## Known limits

- RC evidence is not a complete supply-chain proof. Local provenance is
  unsigned; GitHub attestation exists only after a supported protected tag run.
- The release manifest deliberately marks real non-elevated Windows evidence as
  separately required; GitHub-hosted Windows cannot satisfy it.

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
- `OUTCOME_UNKNOWN` is stable and prevents later commits, but cannot be resolved
  until the separate operation-journal/reconciliation stage exists.
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

Review Issue #19's contract/grant/revision/scheduling/health semantics and its
complete local evidence first. After merge, the next ticket must be the narrow
operation journal, internal operation ID, `OUTCOME_UNKNOWN` persistence and
reconciliation stage. It must not infer approval for a real game, remote
transport, host configuration, durable session, deployment, or desktop
integration from this mock-only contract.
