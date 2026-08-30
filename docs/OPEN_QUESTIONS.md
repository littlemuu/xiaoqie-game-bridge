# Open questions

These choices are intentionally deferred and do not block the offline
foundation:

1. Which local user-controlled mechanism should own safety resume: a small tray
   UI, a CLI attached to the host process, or an OS-specific control channel?
2. Before a real adapter, should adapters run in the bridge process or in a
   separately sandboxed child with a narrower IPC contract?
3. What durable audit destination and retention period should be used without
   collecting game chat, credentials, or unnecessary personal data?
4. Beyond the bounded stdio handler gate, which per-principal and per-action
   rate limits would a future authenticated transport require?
5. Must the first real adapter support cooperative cancellation for in-flight
   actions, or should safety stop instead guarantee only that no new action can
   begin and surface the current in-flight count to the local user?

The next work order is intentionally not preselected. First review the
mock-only stdio/MCP boundary and its cancellation, identity, capacity, and
child-process evidence. That review does not authorize a real game, remote
transport, MCP host configuration, or desktop integration.
