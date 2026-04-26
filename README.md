# agentcash-telegram

A quote-bound, spend-controlled Telegram surface for AgentCash. Designed to demonstrate safe payment UX and per-user wallet isolation.

**This is an MVP, not production-ready custody.** Hosted production would require a deeper custody and infrastructure review. See [docs/security.md](docs/security.md) for the honest security posture.

## What this is

AgentCash already works well in CLI, MCP, and developer tooling. This project brings it into a chat-native interface without changing the underlying payment model:

- fund a wallet once
- call paid x402/MPP endpoints from Telegram chat
- per-user isolation with explicit spend controls and immutable quote records

## Payment safety model

Every paid call goes through this sequence before execution:

1. **Quote** — AgentCash CLI is queried for a bounded cost estimate. If it cannot produce one, the call does not run.
2. **Confirmation** (if over cap) — user sees exact skill, quoted price, and expiry. An immutable `quotes` record is created.
3. **Approval** — quote is atomically marked approved (SQL `UPDATE WHERE status='pending'`). Replay attacks are rejected.
4. **Execution** — the canonical request stored in the quote record is executed, not re-parsed from user input.
5. **Audit** — quote and transaction records are updated with actual cost and response hash.

If any step fails, the call stops. Failed preflight attempts are logged in `preflight_attempts` for audit.

## Features

- Telegram private-chat bot
- `/start`, `/deposit`, `/balance`, `/cap`, `/history`
- `/research`, `/enrich`, `/generate`
- per-user AgentCash wallet isolation
- spending caps with hard MVP safety ceiling
- confirmation flow for over-cap or natural-language requests
- transaction logging with request/response hashes
- optional natural-language routing when model keys are configured
- local SQLite storage

## Roadmap

- Telegram group wallets
- Telegram inline query mode
- Discord port
- production Postgres adapter
- distributed lock
- KMS/HSM custody model
- key rotation
- hosted deployment with production custody review

## Setup

### 1. Clone

```bash
git clone <repo>
cd agentcash-telegram
```

### 2. Install

```bash
corepack pnpm install
```

If `better-sqlite3` has not been built yet:

```bash
corepack pnpm approve-builds
```

### 3. Create bot credentials

Create a Telegram bot with BotFather and copy the token.

### 4. Configure environment variables

```bash
cp .env.example .env
openssl rand -base64 32
```

Put the generated value into `MASTER_ENCRYPTION_KEY`.

Minimum required:

- `TELEGRAM_BOT_TOKEN`
- `MASTER_ENCRYPTION_KEY`

Optional:

- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` — enables natural-language routing
- `BOT_MODE=webhook` plus webhook settings for hosted deployments
- `ALLOW_UNQUOTED_DEV_CALLS=true` — local dev only: runs calls even if AgentCash CLI cannot quote them. Marks transactions as `dev_unquoted`. **Never use in production.**

Webhook mode requires `WEBHOOK_DOMAIN` and `WEBHOOK_SECRET_TOKEN`.

### 5. Run locally

```bash
corepack pnpm dev
```

Checks:

```bash
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

## Production Readiness

Hosted deployment is not production-custody-ready.

Still not production custody:

- SQLite remains local-only
- locks are process-local only
- private keys are decrypted into process memory for AgentCash CLI
- no managed KMS/HSM
- no key rotation procedure
- no immutable external audit log shipping

Read [docs/deployment.md](docs/deployment.md) and [docs/custody-review.md](docs/custody-review.md) before hosting anything with real funds.

## Demo flow

1. `/start` — provisions wallet, shows deposit address
2. `/deposit` — shows funding details
3. `/balance` — balance and spend cap state
4. `/cap 0.25` — set the per-call confirmation cap
5. `/research latest x402 ecosystem activity` — quoted, confirmed if above cap, executed
6. `/enrich jane@example.com` — same flow
7. `/generate lobster wearing a tuxedo` — image generation with optional job polling
8. `/history` — sanitized transaction history with costs and request hashes

## Architecture

```mermaid
flowchart LR
  user["Telegram User"]
  bot["Bot + Rate Limiter"]
  router["Router (optional)"]
  executor["Skill Executor"]
  quotes["Quotes DB"]
  agentcash["AgentCash CLI"]
  api["x402 / MPP API"]

  user --> bot
  bot --> router
  bot --> executor
  router --> executor
  executor --> quotes
  executor --> agentcash
  agentcash --> api
```

- Slash commands are the primary trusted path.
- Non-slash messages route through the optional NL router, always with `forceConfirmation=true`.
- All paid calls create a quote before execution. Auto-approved if below cap, confirmation required if above.
- Confirm callbacks use `quote_id` — not re-parsed user input.

See [docs/architecture.md](docs/architecture.md) for more detail.

## Security posture

See [docs/security.md](docs/security.md) for the full, honest posture.

Key points:
- Telegram IDs are hashed (HMAC-SHA256) before storage in payment/audit tables
- Private keys are encrypted at rest (AES-256-GCM) with `MASTER_ENCRYPTION_KEY`
- Current command paths do not store usernames or personal names in payment/audit tables; the local `users` schema still has nullable legacy name columns that should be removed in a production migration
- Quote records are immutable and replay-protected at the SQL level
- AgentCash CLI dependency is a known risk: it runs as a subprocess and must be trusted
- SQLite is local-only and not suitable for distributed production
