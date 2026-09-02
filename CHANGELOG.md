# Changelog

All notable changes to PuddingTeams are documented here. The project follows Semantic Versioning.

## [1.0.0] - 2026-09-02

### Added

- Room-as-group-chat collaboration with solo, group and managed orchestration modes.
- Goal, work plan, workspace handoff, artifact and HITL approval flows.
- Unified Agent Runtime and PWCP semantics for pi, Codex, Claude Code and PuddingClaw.
- Extension Registry, first-party Connector packages and Capability packages.
- Electron desktop distribution for macOS arm64/x64 and Windows x64.
- Public documentation site, release verification and CI/release automation.

### Changed

- Source deployments now require Node.js 22.19.0 or newer.
- First-party Extensions target the PuddingTeams 1.x host range.

### Known limitations

- Windows artifacts require Authenticode signing before they should be presented as a trusted stable installer.
- Generic HTTP/RPC/ACP transports, Extension process isolation and a public Extension marketplace are not part of 1.0.

[1.0.0]: https://github.com/ZzjNoMercy/PuddingTeams/releases/tag/v1.0.0
