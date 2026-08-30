# Open questions

These choices are intentionally deferred and do not block the offline
foundation:

1. Which local user-controlled mechanism should own safety resume: a small tray
   UI, a CLI attached to the host process, or an OS-specific control channel?
2. Before a real adapter, should adapters run in the bridge process or in a
   separately sandboxed child with a narrower IPC contract?
3. Which transport should be prototyped first after local stdio validation:
   loopback HTTP, MCP stdio, or an authenticated relay client?
4. What durable audit destination and retention period should be used without
   collecting game chat, credentials, or unnecessary personal data?
5. Which per-action rate and concurrency limits are appropriate for the first
   Minecraft adapter?
6. What per-session and global request-cache limits, cleanup cadence, and closed
   session retention window should a long-lived host use?
7. Must the first real adapter support cooperative cancellation for in-flight
   actions, or should safety stop instead guarantee only that no new action can
   begin and surface the current in-flight count to the local user?
