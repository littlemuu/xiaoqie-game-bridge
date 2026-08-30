# Open questions

These choices are intentionally deferred and do not block the offline
foundation:

1. Which local user-controlled mechanism should own safety resume: a small tray
   UI, a CLI attached to the host process, or an OS-specific control channel?
2. Before a real adapter, which actual OS isolation should wrap the now-proven
   narrow process IPC: restricted token/job object, container, VM, or an
   adapter-specific sandbox?
3. What durable audit destination and retention period should be used without
   collecting game chat, credentials, or unnecessary personal data?
4. Beyond the bounded stdio handler gate, which per-principal and per-action
   rate limits would a future authenticated transport require, and which
   authentication methods should map to stable subjects without account
   confusion?
5. Must the first real adapter support cooperative cancellation for in-flight
   actions, or should safety stop instead guarantee only that no new action can
   begin and surface the current in-flight count to the local user?
6. Which filesystem, process, game API, save-backup, CPU, and memory permissions
   should be separately granted to the first real adapter worker?

The next work order is intentionally not preselected. First review the
mock-only stdio/MCP boundary and its cancellation, identity, capacity, and
child-process evidence. That review does not authorize a real game, remote
transport, MCP host configuration, or desktop integration.

The core now has a strict future-remote owner seam, but it intentionally does
not answer credential verification, subject lifecycle, revocation, distributed
session persistence, or cross-process replay. Local owner scope ends with the
stdio process because its sessions and owner keys are memory-only. Those are
separate design and authorization gates before any remote endpoint exists.

The fixed mock worker answers only protocol and ordinary fault-containment
questions. It does not authorize real adapter code, establish a hostile-code
sandbox, guarantee cooperative cancellation, or protect game saves.
