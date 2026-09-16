# Changelog

## Unreleased

- Replace Zod-internal adapter schema introspection with bounded immutable
  `defineAdapterSchema(json)` contracts. Adapter authors must migrate their
  declarations; the MCP request surface and runtime safety rules are unchanged.
- Build once in ordinary CI; retain full reproducibility for tags/manual checks.
- Share test discovery with evidence, parse workflow YAML structurally, and
  cover ledger truncation states without one disk fixture per payload byte.

## 0.1.0-rc.1

- Establishes the mock-only, offline-first, default-deny bridge candidate.
- Includes protocol, caller-bound sessions, policy and capability checks,
  idempotency, safety controls, bounded durable audit, strict fixed-worker IPC,
  and source-built Windows Restricted Token plus Job containment.
- Adds a deterministic source-build bundle, SHA-256 checksum manifest,
  CycloneDX 1.6 JSON SBOM, machine-readable release manifest, unsigned local
  provenance statement, and protected-tag GitHub attestation workflow.
- Adds closed-world Windows evidence generation that distinguishes elevated,
  non-elevated, skipped, failed, and unknown evidence.

This candidate is not production-ready. It has no real game adapter, remote
transport, host configuration, account integration, save access, or hostile-code
sandbox guarantee.
