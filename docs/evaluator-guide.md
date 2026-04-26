# Evaluator Guide

This guide is the quickest way to understand the v0.1 package without reading every file.

## Fast Path

1. Read [README.md](../README.md).
2. Read [docs/readiness.md](readiness.md).
3. Run:

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm smoke:dry
corepack pnpm release:check
```

4. Inspect the quote, custody, and group/guild admin tests.

## Files To Inspect

| Area | Files |
| --- | --- |
| Telegram commands | `src/bot.ts`, `src/commands/groupWallet.ts`, `src/telegram/adminVerifier.ts` |
| Discord commands | `src/discordBot.ts` |
| Quote safety | `src/agentcash/skillExecutor.ts`, `src/db/client.ts`, `test/safety.test.ts`, `test/concurrency.test.ts` |
| Wallets | `src/wallets/walletManager.ts` |
| Custody boundary | `src/custody/signer.ts`, `src/custody/localCliSigner.ts`, `src/custody/remoteSignerClient.ts`, `src/custody/kmsSigner.ts` |
| Storage and locks | `src/db/DatabaseAdapter.ts`, `src/locks/LockManager.ts`, `migrations/` |
| Readiness and operations | `src/configValidation.ts`, `src/healthServer.ts`, `src/audit/AuditSink.ts`, `docs/runbooks/` |
| Release validation | `scripts/smoke-live.ts`, `scripts/release-check.ts` |

## Tests To Run

```bash
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:dry
corepack pnpm release:check
```

Optional, if a Postgres URL is available:

```bash
DATABASE_PROVIDER=postgres DATABASE_URL=<url> corepack pnpm db:migrate
```

## Risks To Look At

- `local_cli` custody is demo-only.
- The remote signer and KMS paths are interfaces/stubs, not production implementations.
- Postgres migrations and adapter scaffolding exist, but the synchronous repository surface is not fully wired to Postgres in the live app.
- Redis locks are implemented with ownership tokens and Lua release. Execution leases and operator reconciliation exist, but lock renewal, continuous scheduling, and upstream AgentCash reconciliation are not complete.
- File/HTTP audit shipping is wired through a DB-backed outbox, but immutable storage, retention evidence, and alerting are not productionized.
- Live Telegram, Discord, webhook, inline, and funded AgentCash smoke evidence must be captured per environment.

## Intentionally Not Productionized

- Hosted custody.
- Managed KMS/HSM integration.
- Full Postgres repository replacement.
- Global paid-call concurrency enforcement across all app instances.
- Automated funded end-to-end tests.
- Multi-region deployment.
- Formal incident response staffing or compliance posture.

## What A Next PR Would Do

1. Finish the Postgres repository adapter and run the full test suite against SQLite and Postgres.
2. Add audit ship-failure alerting, retention policy, and immutable external audit storage.
3. Implement upstream AgentCash reconciliation and continuous scheduling for the execution reconciler.
4. Build a remote signer service and replace `local_cli` for production-like deploys.
5. Capture dated live smoke evidence and attach it to [docs/release-checklist.md](release-checklist.md).
