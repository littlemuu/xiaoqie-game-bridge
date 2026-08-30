# Open questions

These choices are intentionally deferred and do not block the offline
foundation:

1. Which local user-controlled mechanism should own safety resume: a small tray
   UI, a CLI attached to the host process, or an OS-specific control channel?
2. Before a real adapter, should adapters run in the bridge process or in a
   separately sandboxed child with a narrower IPC contract?
3. What durable audit destination and retention period should be used without
   collecting game chat, credentials, or unnecessary personal data?
4. Which per-action rate and concurrency limits are appropriate for the first
   Minecraft adapter?
5. Must the first real adapter support cooperative cancellation for in-flight
   actions, or should safety stop instead guarantee only that no new action can
   begin and surface the current in-flight count to the local user?

The next work order is decided rather than open: a local-only stdio/MCP contract
test using only the mock adapter, with no listener or real game integration.
