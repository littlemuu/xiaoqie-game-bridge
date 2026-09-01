# v0.1.0-rc.1 support matrix

| Environment | What is required | What it may claim |
| --- | --- | --- |
| Linux canonical builder | Node 22.23.1, two local clean clones, offline lockfile installs after the initial CI install | Identical normalized bundle digests and platform-neutral regression results |
| GitHub-hosted Windows | Exact Node version, MSVC build, explicit administrator check, pre-worker rejection test | The native source compiles with MSVC/UCRT and the product fails closed on the elevated host |
| Real non-elevated Windows | Full suite plus the closed-world evidence generator | Restricted Token, Job and local named-pipe paths only when the real checks pass; every skip/failure/unknown remains visible |

The machine-readable companion is `support-matrix-v1.json`. GitHub-hosted
Windows is intentionally not treated as non-elevated evidence. If a suitable
real non-elevated host report is absent, the release manifest stays
`requires-separate-real-host-evidence`.

No row supports a real game, account, launcher, save, desktop control, remote
transport, host MCP configuration, or untrusted adapter code. Restricted Token
and Job containment do not prevent all current-user-readable file or network
access and are not a hostile-code sandbox.
