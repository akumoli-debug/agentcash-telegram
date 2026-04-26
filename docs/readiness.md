# Final-Product Readiness

This repo is demo-oriented and locally verifiable. It is not yet a production custody product.

## Current Shipped Features

- Telegram private-chat commands: `/start`, `/deposit`, `/balance`, `/cap`, `/research`, `/enrich`, `/generate`, `/history`.
- Per-user wallet rows with isolated AgentCash home directories.
- Local SQLite schema initialization and compatibility migrations.
- Bounded quote flow before paid execution.
- Immutable canonical request storage in `quotes`.
- Atomic quote approval to reject replay.
- Transaction, preflight, and audit event records.
- Health endpoints at `/healthz` and `/readyz`.
- Startup AgentCash CLI health check, enabled by default.

## Experimental Features

- Telegram `/groupwallet` for group wallet creation, balance/deposit lookup, group paid calls, and over-cap admin approval.
- Telegram inline query mode with preview-only inline results and signed start payloads.
- Discord MVP `/ac` commands for DM user-wallet balance, deposit, and research.
- Telegram webhook mode.
- Optional natural-language routing for Telegram text messages.

These have automated coverage, but they are not final-product claims until live Telegram/Discord/webhook smoke evidence is captured.

## Production Blockers

- SQLite is local-only and has no production backup/restore workflow.
- Postgres migrations and adapter exist, but the full repository layer is not wired to Postgres yet.
- Redis locking exists for coordination, but lock renewal and stuck-execution reconciliation are not implemented.
- `local_cli` custody is demo-only; decrypted key env passing is isolated in `LocalCliSigner` but still happens.
- No implemented remote signer or KMS/HSM signer.
- Local key version tracking exists, but no automatic fund migration, production key rotation, or break-glass process exists.
- No external immutable audit log shipping.
- No multi-region or multi-replica coordination.
- No live funded smoke record for Telegram, Discord, inline mode, webhook mode, or group wallets.
- Health endpoints do not prove AgentCash CLI health, bot reachability, payment rails, or database durability.

## Live Smoke Checklist

Prerequisites:

- Real `MASTER_ENCRYPTION_KEY`.
- Real `TELEGRAM_BOT_TOKEN` for Telegram smoke.
- Real `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID` for Discord smoke.
- Working AgentCash CLI in `AGENTCASH_COMMAND`/`AGENTCASH_ARGS`.
- Funded wallet only when intentionally testing paid calls.
- `LIVE_FUNDS_TEST=true` only for an intentional funded manual test.

Commands:

```bash
corepack pnpm smoke:dry
corepack pnpm smoke:agentcash
corepack pnpm smoke:live -- --no-funds
```

Telegram private chat:

1. Start the app.
2. DM `/start`; verify wallet/deposit response.
3. Run `/deposit` and `/balance`.
4. Run `/cap 0.25`.
5. Run `/research latest x402 ecosystem activity`.
6. If quoted above cap, confirm once.
7. Press the same confirm button again; verify replay is rejected.
8. Run `/history`; verify sanitized cost/request hash fields.

Telegram group wallet:

1. Add the bot to a group or supergroup.
2. Make the bot a group admin so it can verify `getChatMember` and `getChatAdministrators`.
3. From a Telegram creator/admin account, run `/groupwallet create`.
4. From a non-admin account, verify `/groupwallet create` is refused.
5. Run `/groupwallet sync-admins` and `/groupwallet roles`.
6. Run `/groupwallet balance`.
7. Run a paid command in the group.
8. Verify over-cap approval requires both internal owner/admin role and current Telegram admin status.

Telegram inline:

1. Enable inline mode in BotFather.
2. Type `@<bot username> research x402` in a chat.
3. Verify the preview appears without paid execution.
4. Open the result and verify confirmation is required before execution.

Discord:

1. Install the Discord app with `bot` and `applications.commands` scopes.
2. Start the app and wait for global `/ac` propagation.
3. In a DM, run `/ac balance`, `/ac deposit`, and `/ac research query:latest x402 ecosystem activity`.
4. Confirm once if prompted.
5. Re-click confirm and verify replay rejection.
6. In a guild channel, verify the current guild-wallet limitation is returned.

Webhook:

1. Run with `BOT_MODE=webhook`, `WEBHOOK_DOMAIN`, `WEBHOOK_PATH`, and `WEBHOOK_SECRET_TOKEN`.
2. Set the Telegram webhook with the same secret token.
3. Verify Telegram updates reach the app over HTTPS.
4. Verify `/healthz` and `/readyz` are reachable separately from webhook traffic.

## Known Risks

- AgentCash CLI output format changes could break quote/check/fetch parsing.
- Paid endpoint schemas may change independently of this app.
- Local wallet custody is not a hosted-custody design; `remote_signer`/`kms` are only stubs or future paths today.
- Discord global command registration can lag.
- Telegram inline and webhook behavior depends on external BotFather and HTTPS configuration.
- `ALLOW_UNQUOTED_DEV_CALLS=true` is useful for local development but removes bounded quote proof.
- `SKIP_AGENTCASH_HEALTHCHECK=true` is useful for demos but must stay disabled in production.

## Demo Ready Means

- `corepack pnpm format`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm test`
- `corepack pnpm build`
- `corepack pnpm smoke:dry`
- AgentCash CLI health check passes in the demo environment, unless explicitly running a no-AgentCash local dry demo.
- Manual Telegram and/or Discord checklist results are recorded with date, environment, and whether funds were used.

## Production Ready Would Require

- Fully wired Postgres repository adapter with migrations, backups, restore drills, and transactional tests.
- Distributed locking with ownership tokens, expiry handling, renewal, and stuck execution reconciliation.
- Managed key custody with a reviewed remote signer or KMS/HSM, rotation, revocation, and incident procedures.
- External audit log shipping.
- Live end-to-end tests or monitored smoke runs for Telegram, Discord, webhook, AgentCash quote/check/fetch, and funded execution.
- Secrets management and deployment hardening.
- Rate-limit, abuse, and operational monitoring.
- Security review for subprocess execution, wallet isolation, and data retention.
