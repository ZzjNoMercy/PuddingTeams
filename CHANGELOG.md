# Changelog

All notable changes to PuddingTeams are documented here. The project follows Semantic Versioning.

## [1.1.0] - 2026-09-23

### Added

- Added an in-app runtime file and artifact viewer for inspecting worker outputs without leaving a room.
- Added inline pi worker conversations and richer execution context directly in the message timeline.
- Added scoped follow-up coverage and explicit workspace owner lifecycle handling for long-running collaboration.

### Changed

- Stabilized Goal and WorkPlan lifecycle transitions, including human-wait recovery, completion evidence and session restoration.
- Improved artifact persistence, runtime context projection and room execution state synchronization.

### Fixed

- Recovered truncated pi output without incorrectly reporting successful completion.
- Hardened worker approval, cancellation and restart recovery paths.

### Known limitations

- The Windows 1.1.0 installer may be unsigned when the Release workflow has no Authenticode credentials; verify its published SHA-256 before installation.

## [1.0.2] - 2026-09-06

### Changed

- Made Windows Authenticode signing optional in the automated desktop release: valid credentials produce and verify a signed installer, while absent credentials produce a verified unsigned installer with an explicit release warning.

### Fixed

- Preserved numeric input/output token usage metadata during recursive credential redaction and guarded the session UI against non-finite usage values.
- Made runtime assembly invoke the active pnpm CLI portably so Windows release runners can build the bundled Web application.
- Ensured the release workflow notarizes and staples the outer macOS DMG after the packaged application passes notarization.

### Known limitations

- The Windows 1.0.2 installer is unsigned and may trigger an Unknown Publisher or SmartScreen warning; verify its published SHA-256 before installation.

## [1.0.1] - 2026-09-03

### Fixed

- Hardened Worker recovery so reconciled and reattached runs preserve their observed start boundary and terminal receipt state.
- Made managed MCP startup eager and bounded, with graceful Agent startup when an MCP catalog or server is unavailable.
- Corrected Worker process presentation for recovered external runs and interaction cards.

### Known limitations

- The Windows 1.0.1 installer is unsigned and may trigger an Unknown Publisher or SmartScreen warning; verify its published SHA-256 before installation.

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

- The Windows 1.0.0 installer is unsigned and may trigger an Unknown Publisher or SmartScreen warning; verify its published SHA-256 before installation.
- Generic HTTP/RPC/ACP transports, Extension process isolation and a public Extension marketplace are not part of 1.0.

[1.1.0]: https://github.com/ZzjNoMercy/PuddingTeams/releases/tag/v1.1.0
[1.0.2]: https://github.com/ZzjNoMercy/PuddingTeams/releases/tag/v1.0.2
[1.0.1]: https://github.com/ZzjNoMercy/PuddingTeams/releases/tag/v1.0.1
[1.0.0]: https://github.com/ZzjNoMercy/PuddingTeams/releases/tag/v1.0.0
