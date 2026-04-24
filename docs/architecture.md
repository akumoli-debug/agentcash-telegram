# Architecture

## Runtime

- TypeScript
- Node 20+
- `pnpm` package management to match the surrounding Merit repos more closely than Bun
- `telegraf` for Telegram transport
- `better-sqlite3` for local persistence
- `zod` for configuration and command validation
- `pino` for structured logging

## Modules

- `src/index.ts`
  - process bootstrap
  - config loading
  - db initialization
  - bot startup and shutdown
- `src/config.ts`
  - env parsing and runtime config
- `src/bot.ts`
  - Telegraf bot creation and command registration
- `src/db/*`
  - schema creation and typed SQLite access
- `src/wallets/walletManager.ts`
  - wallet records, spend caps, deposit QR generation
- `src/agentcash/agentcashClient.ts`
  - boundary to AgentCash CLI integration
- `src/commands/*`
  - per-command handlers
- `src/lib/*`
  - logger and app errors

## Data Model

The schema is deliberately group-ready, but runtime logic only provisions user-owned wallets for now.

- `users`
  - Telegram identity and display metadata
- `wallets`
  - `kind` supports `user` and `group`
  - current implementation only creates `user`
- `transactions`
  - command-level audit trail and payment metadata
- `sessions`
  - simple per-chat conversational state for future multi-step flows

## AgentCash integration strategy

Current scaffold assumes a subprocess adapter over the CLI boundary first.

Reasons:

- Merit repos expose AgentCash primarily through CLI/MCP flows
- wallet isolation needs explicit per-user control
- app-level spend cap enforcement should happen before a paid fetch

## Wallet isolation

- each Telegram user gets a deterministic hashed AgentCash home directory under `data/agentcash-homes/`
- folder names are derived from a keyed hash, never the raw Telegram ID
- the app injects wallet secrets through env vars at execution time when needed
- encrypted wallet secret material is stored with AES-256-GCM using `MASTER_ENCRYPTION_KEY`
- raw wallet secrets are never logged

## Paid command execution

`/research`, `/enrich`, and `/generate` all flow through one shared executor:

1. validate input
2. load isolated wallet
3. check balance
4. estimate cost from `check` or a deterministic fallback
5. enforce user spend cap
6. execute the paid request
7. store only hashes plus transaction metadata
8. format a concise Telegram response

TODO seams are called out in:

- `src/agentcash/agentcashClient.ts`
- `src/wallets/walletManager.ts`

## Privacy and logging

- never log raw private keys
- never log raw Telegram message text by default
- avoid logging usernames, first names, and last names together unless operationally necessary
- transaction logs may store structured request metadata, but command handlers should prefer summaries over raw user text
