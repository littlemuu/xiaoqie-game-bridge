# Open questions

- Will repository rules protect the annotated `v0.1.0-rc.1` tag and permit the
  official GitHub artifact-attestation action? The release workflow fails closed
  until both platform capabilities are available.
- Where will durable real non-elevated Windows RC evidence be retained? Hosted
  Windows is elevated and cannot replace that report.
- What project license should a later public distribution carry? This RC does
  not invent or add a license grant that the maintainer has not selected.

These choices are intentionally deferred and do not block the offline
foundation:

The local resume-owner question is resolved for this mock phase: a narrow CLI
uses a per-launch authenticated Windows named pipe that is separate from MCP and
controls the same product safety latch. The remaining choices are:

1. Restricted Token + Job Object is now selected for the trusted mock worker's
   privilege, process-tree, resource, and lifetime boundary. Before a real
   adapter, which additional file, registry, network, game API, and save boundary
   is required: AppContainer, container/VM, ACL policy, or adapter-specific broker?
2. The bounded fixed local audit destination is now selected. Should a future
   ticket add an explicitly approved retention/deletion policy, and if so how
   should evidence be deleted without accepting arbitrary paths or silently
   evicting history under pressure?
3. Beyond the bounded stdio handler gate, which per-principal and per-action
   rate limits would a future authenticated transport require, and which
   authentication methods should map to stable subjects without account
   confusion?
4. Must the first real adapter support cooperative cancellation for in-flight
   actions, or should safety stop instead guarantee only that no new action can
   begin and surface the current in-flight count to the local user?
5. Which filesystem, process, game API, save-backup, CPU, and memory permissions
   should be separately granted to the first real adapter worker?
6. Before any stronger local-adversary claim, should the operator descriptor
   receive an explicit Windows DACL, a restricted-token broker, or a different
   OS-owned rendezvous mechanism? Current inherited ACL evidence is not such a
   proof.
7. Does a future audit design need a protected signing key or external anchor?
   The current SHA-256 chain deliberately detects ordinary damage only and is
   not hostile same-user or offline-disk tamper proof.

The next work order is intentionally not preselected. First review the
mock-only stdio/MCP and operator boundaries, including cancellation, identity,
capacity, ACL, cleanup, and child-process evidence. That review does not
authorize a real game, remote
transport, MCP host configuration, or desktop integration.

The core now has a strict future-remote owner seam, but it intentionally does
not answer credential verification, subject lifecycle, revocation, distributed
session persistence, or cross-process replay. Local owner scope ends with the
stdio process because its sessions and owner keys are memory-only. Those are
separate design and authorization gates before any remote endpoint exists.

The fixed mock worker answers only protocol and ordinary fault-containment
questions. It does not authorize real adapter code, establish a hostile-code
sandbox, guarantee cooperative cancellation, or protect game saves.

The durable ledger is likewise not authorization for cloud logging, a
database, telemetry upload, persistent bearer secrets, arbitrary file access,
automatic deletion, or a game-save format. Each requires a separate work order.
