# Architecture

The shipped MVP demo scope is Telegram private chat only: wallet funding details, balance, caps, `/research`, `/enrich`, `/generate`, confirmation, and sanitized `/history`.

## Runtime

- TypeScript
- Node 22 LTS
- `pnpm` package management
- `telegraf` for Telegram transport
- `discord.js` for Discord transport
- `better-sqlite3` for local persistence
- `zod` for configuration and command validation
- `pino` for structured logging

## Modules

- `src/index.ts` — process bootstrap, config, startup health check, bot lifecycle
- `src/config.ts` — env parsing and runtime config
- `src/bot.ts` — Telegraf bot creation, middleware, command registration, confirm/cancel handlers
- `src/discordBot.ts` — Discord slash command and button adapter
- `src/core/*` — transport-neutral command context and command logic
- `src/db/schema.ts` — SQLite schema definitions
- `src/db/client.ts` — typed SQLite access, quote operations, preflight logging, history query
- `src/db/adapter.ts` — small TODO seam for future Postgres migration
- `src/wallets/walletManager.ts` — wallet records, spend caps, per-user locking for provisioning
- `src/agentcash/agentcashClient.ts` — **single boundary for AgentCash CLI integration** (startup health check here)
- `src/agentcash/skillExecutor.ts` — quote creation, confirmation flow, approved-quote execution
- `src/commands/*` — per-command handlers
- `src/lib/lockManager.ts` — lock abstraction and local in-process implementation
- `src/lib/userLock.ts` — compatibility wrapper over the local lock manager
- `src/healthServer.ts` — `/healthz` and `/readyz` HTTP server
- `src/lib/crypto.ts` — AES-256-GCM encryption, HMAC hashing
- `src/lib/errors.ts` — typed error classes including `QuoteError`
- `src/lib/logger.ts` — pino with secret redaction
- `src/router/routerClient.ts` — optional NL router (OpenAI or Anthropic), always produces forceConfirmation

## Data Model

```
users               — Telegram user ID for lookup, cap settings (nullable legacy name columns are not populated)
delivery_identities — user_hash → telegram_user_id (PII isolated here)
wallets             — per-user wallet metadata, encrypted private key
quotes              — immutable quote record per paid call attempt
transactions        — execution audit trail linked to quotes
preflight_attempts  — failed quote/balance/cap/replay attempts
sessions            — active quote_id per chat (for confirm/cancel routing)
request_events      — rate limit event log (pruned after 2 hours)
audit_events        — structured sanitized audit trail
inline_payloads     — signed short-lived inline start payloads
```

Telegram group wallets, Telegram inline mode, and Discord support are roadmap/experimental surfaces. They are not part of the shipped private-chat MVP demo.

## Paid command execution flow

Every paid call through `/research`, `/enrich`, `/generate`, or NL routing goes through this sequence:

1. **Validate input** — Zod validator on raw user input
2. **Get wallet** — provision or retrieve via wallet manager; locked through `LockManager`
3. **Get balance** — `agentcashClient.getBalance`
4. **Get quote** — `agentcashClient.checkEndpoint` must return a bounded cost estimate
   - If check fails and `ALLOW_UNQUOTED_DEV_CALLS=false`: log preflight failure, throw `QuoteError`
   - If `ALLOW_UNQUOTED_DEV_CALLS=true`: mark `is_dev_unquoted=1`, proceed with cost=0
5. **Check hard cap** — reject if cost > `HARD_SPEND_CAP_USDC`
6. **Check balance** — reject if balance insufficient
7. **Create quote record** — immutable DB row with canonical request JSON and request hash
8. **Confirmation gate** — if cost > user cap or `forceConfirmation`: return `quote_id` to bot for inline keyboard
   - Auto-approve and execute immediately if below cap
9. **Approved execution** (`executeApprovedQuote`) — loads canonical request from quote row, not from user input
   - Atomically marks `approved` (SQL `WHERE status='pending'`)
   - Creates transaction record
   - Calls `agentcashClient.fetchJson`
   - Marks `executed`, links transaction ID
10. **Audit** — all failures update quote status and log to `preflight_attempts`; sanitized lifecycle events are written to `audit_events`

## Confirmation flow (security detail)

The session stores only:
```json
{ "type": "quote_confirmation", "quote_id": "quo_..." }
```

The confirm callback (`confirm:<quote_id>`) is verified against the session. The quote row is the source of truth — not re-parsed user input. Replay protection is at the SQL level: `UPDATE WHERE status='pending'` returns 0 changes if already used.

## AgentCash CLI dependency

All CLI interactions are in `agentcashClient.ts`. Startup health check verifies:
1. CLI binary is executable
2. Home root directory is writable

If either fails, the process exits with a clear error before accepting traffic.

## Deployment scaffold

The repository includes Docker and Docker Compose scaffolding plus a health endpoint. This is for demos and staging-like testing. It is not production custody readiness.

Webhook mode requires `WEBHOOK_SECRET_TOKEN` and `WEBHOOK_DOMAIN`. SQLite remains local-only; `src/db/adapter.ts` marks the seam for a future full Postgres migration.

## PII boundary

| Table | Contains |
|---|---|
| `delivery_identities` | raw `telegram_user_id` → `user_hash` |
| `users` | `telegram_user_id` (for session lookup), cap settings |
| `wallets` | `user_hash` (as `home_dir_hash`), encrypted key |
| `quotes` | `user_hash` only |
| `transactions` | `user_hash` as `telegram_id_hash` and `telegram_chat_id` |
| `preflight_attempts` | `user_hash` only |

Current command paths do not populate usernames, first names, or last names. The SQLite `users` table still contains nullable legacy columns for those values, so a production migration should remove or quarantine them explicitly.

## Privacy and logging

- Never log raw private keys, wallet secrets, or signed payloads
- Never log raw Telegram message text
- Transaction and audit logs store hashes, not raw content
- Pino redaction covers: private keys, API keys, encrypted inputs, session state, raw CLI output
