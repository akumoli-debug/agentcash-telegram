# AgentCash CLI Version

The demo and release path pins the AgentCash CLI instead of using a moving dist tag.

## Tested version

- `AGENTCASH_COMMAND=npx`
- `AGENTCASH_ARGS=agentcash@0.14.3`
- Checked against the npm registry on 2026-04-26.

Development may temporarily use the floating latest dist tag, but config prints a warning. Production rejects floating latest dist tags, and `corepack pnpm release:check` fails if that tag appears in config defaults, `.env.example`, `README.md`, or docs.

## Why it is pinned

The bot depends on stable AgentCash CLI behavior for wallet provisioning, balance/deposit lookup, quote checks, fetch execution, and response parsing. A floating CLI version can change those contracts overnight and break a live Merit Systems demo without any repo change.

## Upgrade process

1. Check the candidate package version with `npm view agentcash version`.
2. Update `TESTED_AGENTCASH_PACKAGE` in `src/config.ts`.
3. Update `.env.example`, this document, and any runbooks or recon notes that show the CLI command.
4. Run the full local validation suite:

```bash
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:dry
corepack pnpm release:check
```

5. Run AgentCash CLI smoke against the candidate version:

```bash
AGENTCASH_COMMAND=npx AGENTCASH_ARGS=agentcash@0.14.3 corepack pnpm smoke:agentcash
```

6. For a live demo upgrade, run a no-funds live smoke first, then a deliberately funded smoke only when the operator is ready to spend.

## Required smoke evidence after upgrade

- Config loads with the pinned `AGENTCASH_ARGS`.
- `/readyz` passes when `SKIP_AGENTCASH_HEALTHCHECK=false`.
- Wallet provisioning and deposit lookup still work.
- Balance lookup still works.
- Quote creation still stores the expected canonical request.
- Confirmation executes exactly once and replay is rejected.
- `corepack pnpm release:check` reports no floating latest dist-tag references.

## Rollback

1. Restore `TESTED_AGENTCASH_PACKAGE` and `.env`/deployment `AGENTCASH_ARGS` to the previous known-good version.
2. Redeploy or restart the bot process.
3. Run `corepack pnpm smoke:dry`.
4. Run `corepack pnpm smoke:agentcash` with the rollback version.
5. Pause funded demos until `/readyz`, quote creation, confirmation, and replay rejection have been rechecked.
