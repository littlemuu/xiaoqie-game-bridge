# Changelog

## Unreleased — Minecraft 展示台（2026-09-16）

- 新增 Java 1.20.4 固定方块 adapter、数据包、本地初始化/下载/服务器/试玩/验收入口与独立 MCP stdio 入口。
- 新增 SQLite 动作 intent/result、内部操作 UUID、崩溃释放锁及游戏端序号对账；丢失确认时停止新写。
- 默认 stopped，可信本地启用、每 session 16 次动作；不增加任意命令或远程 transport。
- 修复 core 在异步 revision 查询期间遇到 stop/quiesce 后仍可能派发的竞态。
- 真实 Minecraft 与 Windows 新入口尚待验收；不宣称新发行版。原 mock RC 发布基线保留。

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
