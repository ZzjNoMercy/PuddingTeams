# Releasing PuddingTeams

PuddingTeams has two supported distribution paths: signed desktop installers and source deployment. The private CLI package is an internal runtime assembly tool, not a public npm installation channel.

## 1. Verify the source tree

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify:release
```

All core manifests must share the release version. First-party Extension manifests must accept the same PuddingTeams major version.

## 2. Build desktop installers

macOS signing and notarization use the Developer ID identity and notary profile documented in `electron/README.md`:

```bash
APPLE_KEYCHAIN_PROFILE=puddingclaw-notary pnpm build:electron:arm64
APPLE_KEYCHAIN_PROFILE=puddingclaw-notary pnpm build:electron
```

Build Windows x64 NSIS on Windows for the final release. A macOS cross-build is useful for structural validation but does not replace Windows install/uninstall testing or Authenticode signing:

```bash
pnpm build:electron:win:x64
```

Windows Authenticode signing is optional in the automated release workflow. When both `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are configured, the workflow signs and verifies the installer. When both are absent, it verifies that the installer is unsigned and adds an explicit warning to the workflow log and GitHub Release. Supplying only one of the two secrets remains a hard failure.

After all three installers are present:

```bash
pnpm release:checksums
```

## 3. Acceptance checklist

- macOS arm64 and x64: `codesign --verify`, `spctl --assess` and notarization succeed; mount, drag-install, first launch, upgrade and uninstall are tested.
- Windows x64: when signing credentials are configured, the Authenticode signature is valid; otherwise the installer is verified as unsigned and the release warning is present. Install, first launch, upgrade, uninstall, Start Menu and desktop shortcuts should be tested on a clean Windows machine before broad promotion.
- The app can create a room, configure a model, delegate to at least one Worker and restore the session after restart.
- `SHA256SUMS.txt` matches the uploaded assets.
- Public docs and the download link resolve without authentication.

## 4. Publish

Create and push the release tag only after the acceptance checklist is complete. The release workflow uploads DMG/EXE/checksum artifacts to the GitHub Release. Never publish a stable release from a dirty worktree.
