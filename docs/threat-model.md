# Threat model

## Assets and trust boundaries

The protected assets are the user's future game process and saves, local
credentials, the integrity of allowed game actions, and the ability to stop the
bridge. Cloud reasoning and future transports are not implicitly trusted to
perform arbitrary local work. The local bridge core remains the enforcement
boundary, and adapters are treated as separately reviewable capability modules.

The current implementation touches none of those real assets. Its only mutable
game asset is an in-memory mock world held by a fixed adapter worker. The MCP
stdio child and nested adapter child are local process boundaries, not proof of
remote identity or OS sandboxing.

## Threats and current controls

### Prompt injection requests broader authority

A model, game text, or untrusted document could instruct a future transport to
run a command or call an undeclared action. The envelope is strict, bridge
actions are enumerated, policy is default-deny, and every adapter action has a
strict schema and explicit capability. There is no generic command, process,
filesystem, network, keyboard, or mouse primitive to invoke.

The MCP tool accepts the existing strict bridge envelope directly. Context,
principal, and transport identity are not tool fields: trusted server code
injects a frozen local context. A caller that adds undeclared envelope fields is
rejected by the SDK schema before `GameBridge.handle`; action-specific schemas
still reject undeclared fields inside `params`.

### Token disclosure and replay

Sessions are memory-only. Audit events store truncated SHA-256 tags instead of
raw request/session identifiers. Attacker-controlled unknown actions and
unregistered adapter IDs are also reduced to fixed categories plus hashed tags.
The product ledger drops generic event metadata entirely; it cannot persist an
undeclared path, game-state/input/output field, or blocklist-evasion value.
The in-memory injectable sink still recursively redacts credential-shaped keys.
Future
transports must keep bearer credentials outside request params, authenticate
before opening a session, encrypt transport traffic, and bound token lifetime.

Caller context is an out-of-band trusted transport input, never an envelope or
MCP field. Its own data-property descriptor values are captured once, then that
captured graph is strict-validated, copied, and deeply frozen before any
`await`. Validation never rereads the caller object, so stateful Proxy values
cannot create a check/copy gap or escape as a raw exception. A session stores
only a domain-separated, length-prefixed full
SHA-256 owner key. Remote ownership binds transport, authentication method, and
subject; local ownership uses a fixed process-local domain. Raw principal,
owner key, and full digest are never serialized. Audit correlation uses a
separately domain-separated 12-hex HMAC tag with a process-memory-only random
32-byte key. The key is copied on bridge construction and never persisted or
serialized, preventing offline enumeration of low-entropy principals from an
observed tag.

Replay within a session is handled by a request-ID cache. The first request
installs an in-flight promise before adapter completion; concurrent or later
identical replays await or return the same response without executing again.
Reusing the ID for different content returns `REQUEST_ID_REUSED`.

Owner comparison occurs before session state, cache lookup or wait, cache
capacity bypass, capability, adapter, world, and safety checks. Therefore a
different or untrusted caller cannot learn a completed response, join an
in-flight promise, stop safety, or exploit the full-cache close bypass. All
such existing-session attempts return fixed `AUTHORIZATION_DENIED` without
revealing the original owner.

### Duplicate or ambiguous actions

Per-session idempotency covers allowed and denied session-scoped requests. A
request fingerprint uses deterministic key ordering. Future distributed
transports must preserve the request ID and must not generate a fresh ID when
automatically retrying a write.

MCP's JSON-RPC request ID is transport bookkeeping and is unrelated to the
bridge `requestId` inside tool arguments. The stdio wrapper does not synthesize,
replace, or automatically retry bridge IDs. A logical-size or handler-capacity
rejection happens before the core, so it creates no idempotency evidence; the
same bridge ID may be tried later when transport capacity is available.

### Runaway loops and excessive call rate

The core has finite session count, per-session request history, and concurrent
commit-write limits. Session open sweeps eligible terminal state before a
stable capacity refusal. Request capacity never evicts in-flight or completed
commit evidence; new requests are refused before adapter execution.

The stdio transport has an explicit 64 KiB read-buffer ceiling. The tool handler
independently measures deterministic UTF-8 envelope bytes and refuses more than
32 KiB. A synchronous gate admits at most eight concurrent handlers by default;
full capacity rejects immediately before bridge/adapter execution and creates no
unbounded queue. Permits release in `finally`. Future remote work still needs
per-principal and per-action rate limits.

### Protocol output or diagnostics leak attacker data

Every core result is validated by `responseEnvelopeSchema`, sanitized, and
serialized deterministically. Invalid output, thrown errors, and mismatched
request identity become a fixed `INTERNAL_ERROR`; raw results, stack traces, and
exceptions are not written to MCP. Stdout carries MCP only. Transport failures
write a fixed message to stderr without embedding the received frame or error.

### Audit loss, corruption, or false durability

The product sink is a fixed-directory, append-only, bounded local ledger rather
than process memory. Each strict versioned frame carries a monotonic sequence,
previous-record digest, and current digest over canonical bytes. Writes are
serialized and do not acknowledge until the complete append/data sync plus
exclusive strict per-sequence confirmation and matching checkpoint file syncs
resolve. Startup verifies identical contiguous evidence sets and the whole
owned frame chain before operator/MCP commit admission. A partial or complete
tail with neither evidence file is provably unacknowledged and is retained/
continued only through one bounded recovery record in a new segment. Missing
or mismatched evidence, a missing/shortened committed frame, checksum/schema/
order failures, unexpected objects, and object-identity changes fail startup
closed without repair.

Limits are 4 KiB per record, 8 outstanding writes, 64 KiB per segment, 8
segments, 2,048 confirmations, 2,048 checkpoints, and 500 ms for ledger shutdown drain. A commit
reservation holds a worst-case record's physical bytes before side effects,
including rotation fragmentation. There is no eviction, deletion,
retry loop, retention timer, upload, database, or remote log service. At the
hard segment limit, ordinary commits and resume refuse before new side effects.
Stop is intentionally asymmetric: it closes the latch synchronously before
attempting audit, so a full/rejected/corrupt sink can degrade the command result
but cannot reopen the gate. A resume authorization must be sync-acknowledged
while its generation/deadline transaction is still live.

The ledger is not a game save and has no fields for requests, adapter
input/output, observations, world/player state, chat, accounts, screens, or
save data. Identifier correlation is limited to existing safe tags. No MCP or
operator command reads records or selects a path.

SHA-256 here detects accidental damage and inconsistent ordering inside a
trusted same-user boundary. There is no protected signing key or external
anchor. Hostile same-user code, an administrator, or an offline disk editor can
rewrite both data and digests or remove a complete tail; this design is not
tamper-proof. Likewise, Node/OS `sync()` acknowledgement does not bypass
hardware caches or guarantee every physical power-loss model.

When shutdown reaches its deadline, native segment/evidence write and sync
continuations reject and no later frame, confirmation, or checkpoint write can
run. Node cannot forcibly cancel an OS file operation already pending; the ledger stops awaiting/reusing that handle.
When the operation settles, its only continuation closes the handle, with
the abort signal—not a later closed-state assignment—owning that cleanup.
Process exit is the fallback; bytes lacking both evidence files remain
unacknowledged on restart.

### Adapter exceeds its authority

Sessions bind to exactly one adapter. Policy uses only that adapter's registered
actions and schemas. Capability names are checked both when the session opens
and when the action executes. A real adapter still requires code review and
adapter-specific sandboxing because TypeScript interfaces alone cannot contain
malicious implementation code.

The parent still owns identity, session binding, capabilities, action schemas,
policy, idempotency, safety, and audit. Static metadata must exactly match the
worker handshake. Caller/session/request identity and secrets never enter IPC.
Fixed executable/argv/cwd plus a minimal supplied environment prevent requests
from turning this into a generic launcher; a credential-shaped parent sentinel
is regression-tested as absent from a real built child.

### Worker protocol or lifecycle failure

IPC has strict versioned messages and bounded frames, payloads, pending calls,
and deadlines. Unknown fields/types, wrong or duplicate IDs, timeout, EOF,
crash, non-zero exit, and hostile stdout fail closed. Stderr is discarded, and
worker/path/stack/raw output never reaches bridge responses or audit. Pending
promises settle once with timers/capacity released; normal close waits for
acknowledged zero exit. There is no unbounded queue.

Process separation contains ordinary faults but does not make the worker
non-malicious. Parent and child share one OS user; there is no restricted token,
container, VM, filesystem ACL boundary, or proven CPU/memory sandbox. A real
adapter still requires separate OS-isolation and permission approval.

### Game save corruption

The current mock-only server does not read or write saves. A future real adapter
should prefer the game's supported API, introduce an explicit save-write
capability separate from ordinary actions, verify backup/restore procedures,
and add adapter-level transaction or confirmation rules where supported.
Dry-run output must never be treated as a backup.

### Safety stop cannot be trusted or is remotely reversed

Any active session with the explicit `safety.stop` capability may latch the
bridge. The local control plane can always stop independently of session/request
capacity and exposes the stopped state plus bounded in-flight count. Once
latched, new commit writes are denied while dry-run, describe, observation, and
session close remain available. `safety.resume` is not a request action. Local
resume is audited and denied while any write remains in flight; stop and denied
resume are audited as well. Read-only status is intentionally not audited.

The product operator channel is a separate Windows named pipe, not an MCP tool.
Its per-launch 32-byte token is discovered only through the fixed Local AppData
descriptor and compared at fixed length with a timing-safe primitive. The
protocol cannot carry a bridge request, path, executable, endpoint override, or
arbitrary action. A stale descriptor or listener collision prevents MCP
startup rather than degrading to TCP or serving without the brake.

This proves separation from the model/MCP request surface, not hostile same-user
isolation. On the tested Windows host, `Get-Acl` shows the application directory
and descriptor inherit the current profile's ordinary ACL entries; Node's
requested `0700`/`0600` modes are not evidence of a Windows user-exclusive ACL.
No custom DACL, integrity label, restricted token, or administrator boundary is
installed. Therefore malicious code running as the same OS user, and any
administrator, remains able to read or replace same-user runtime objects. The
implementation accurately targets only the stated local same-user boundary.
An ungraceful Windows process termination can leave a stale descriptor because
regular files are not kernel-owned pipe objects. A subsequent product start
fails closed and preserves it; it never guesses that an unmatched file is safe
to delete. Normal MCP EOF, transport-error, and server-close paths are bounded
and regression-tested to remove the exact launch object.

A valid resume request is not allowed to open the latch before its asynchronous
audit work and operator deadline succeed. The server aborts the bridge resume
on deadline or client disconnect; audit rejection and late settlement leave
`stopped=true`. Concurrent resume admission is singular and excess attempts are
denied as capacity. A later stop aborts every older pending resume transaction,
including a repeated stop that intentionally preserves `stopGeneration`. The
awaited event is explicitly a durable authorization for one exact generation,
not a claim that resume already completed. A success response is possible only
after that authorization is acknowledged and the still-live transaction commits
synchronously; no fire-and-forget success audit can be lost or remain pending.
A late authorization settlement is therefore not a false completion outcome.
This avoids a failure response paired with an already-open write gate or a
successful stop later being undone by older work.

The latch does not claim forced cancellation. An asynchronous action that
passed `beginWrite()` and entered the worker may complete after stop or client
disconnect; process termination is not proof a real game action rolled back.
The action remains visible and the
configured hard limit bounds how many can exist. A real adapter must decide
whether cooperative cancellation is safe for its game API.

MCP cancellation, EOF, or client disconnect also does not revoke a write permit
that already entered an adapter. It can abandon protocol delivery while the
adapter operation finishes and the handler gate releases afterward. Normal
test/client shutdown closes the client first and server/transport second.

### Capacity pressure blocks safety or closure

Local stop does not traverse a session cache. A full request cache permits
`session.close` to execute without adding another cache entry; the close state
transition is idempotent. Remote `safety.stop` remains an ordinary cached
request, so a caller under request-cache pressure must use the local control
plane. No unbounded tombstone or eviction path is introduced.

The operator connection cap also bounds application work rather than merely
counting accepted sessions. Overflow sockets are immediately destroyed and do
not allocate encoded failure responses, read timers, close timers, or an
application queue. Shutdown enumerates every admitted socket and clears its
tracked timers; a 64-contender flood regression proves the counters never rise
above the configured admission limit. Pending authenticated handlers are also
tracked: disconnect aborts their work, shutdown performs a bounded wait, and
destroyed/closing sockets are rejected before response encoding or timer
allocation. A pending-audit disconnect/shutdown regression releases the audit
late and proves all four public resource counters remain zero. Audit promises
have a separate tracked count; shutdown waits for audit idle within its fixed
deadline, and the regression proves the count remains visible until late
settlement and then returns to zero.

## Residual risks before a real adapter

- Sessions and the idempotency cache are process-local; a restart loses them.
- Client-spawned stdio has no remote authentication, encryption, origin binding,
  per-principal rate limiting, or distributed replay store and must not be
  exposed as a network service.
- The durable audit ledger detects ordinary corruption but is not tamper-proof
  against hostile same-user, administrator, or offline-disk rewriting. It has
  no automatic retention/deletion policy or external anchor.
- The mock worker is a same-user process boundary, not a proven OS sandbox for
  hostile or real-game adapter code.
- Capability grants are approved by a simple local-only authorizer; the stdio
  boundary is the trusted component that asserts locality. A test-only remote
  authorizer proves the core seam, but no production remote authentication or
  transport exists.
- Already-started adapter writes are not forcibly cancelled; real adapters may
  require cooperative cancellation semantics.
- The operator launch token and stop generation are process-local. The token is
  authentication only within the stated same-user boundary; the generation is
  concurrency/replay protection, not authentication or a durable replay store.

These are blockers for exposing a real game or remote endpoint, but they do not
block the offline mock foundation.
