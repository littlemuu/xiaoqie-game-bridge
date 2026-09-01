# xiaoqie-game-bridge v0.1.0-rc.1

This prerelease is a mock-only, offline-first, default-deny candidate baseline.
It packages the reviewed protocol/session/policy/capability/idempotency/safety
core, bounded durable audit, one fixed mock worker, strict IPC, and source-built
Windows containment.

The release assets include one normalized source-build bundle, a SHA-256 list,
a CycloneDX 1.6 JSON SBOM, a release manifest, and an unsigned local provenance
statement. The protected tag workflow also requests a GitHub artifact
attestation whose subject is the bundle digest.

It is not production-ready. It does not connect to Minecraft or any other real
game, account, launcher, save, desktop, remote transport, or existing MCP host.
It is not a complete supply-chain proof, hostile-code sandbox, all-platform
validation, or proof of real-game safety. See `docs/release.md` and
`docs/support-matrix.md` before evaluating the candidate.
