# Contributing to PuddingTeams

Thanks for helping improve PuddingTeams. Bug reports, documentation fixes, Connector ideas and focused pull requests are welcome.

## Before opening a pull request

1. Search existing issues and discussions.
2. Keep changes focused and explain the user-visible outcome.
3. For behavior changes, update the relevant design document under `docs/` and public documentation under `apps/docs/`.
4. Add or update tests for changed behavior.
5. Run the release checks:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify:release
```

Source development requires Node.js 22.19.0 or newer and pnpm 10.32.1.

## Connector boundary

Connector and Capability Extensions are independently installable pi packages. The pi entry point is only the package façade; the Driver SPI is the PuddingTeams integration. Shared core code must not depend on either host. See `extensions/README.md` before adding a package and update its index when you do.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).
