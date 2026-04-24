# Security Notes

## Wallet isolation model

- Each Telegram user gets a distinct AgentCash wallet context.
- Wallet homes are isolated under `data/agentcash-homes/<telegram_id_hash>/`.
- Folder names use a keyed hash, not the raw Telegram ID.
- SQLite stores only wallet metadata needed for operation.
- If private key material is captured from AgentCash CLI state, it is stored encrypted with AES-256-GCM using `MASTER_ENCRYPTION_KEY`.

## Logging model

- The bot does not intentionally log raw private keys, raw signed payloads, or raw AgentCash API responses.
- Transaction logging stores request and response hashes, not raw bodies.
- Telegram identifiers are hashed before application logging.
- Logger redaction covers common secret-bearing fields including private keys, API keys, webhook secrets, encrypted pending inputs, and raw payload fields.

## Spending cap model

- Default per-call confirmation cap is `$0.50`.
- Hard MVP cap is `$5.00` unless `ALLOW_HIGH_VALUE_CALLS=true`.
- Slash commands and natural-language routed calls both go through `skillExecutor`.
- Natural-language routed calls always require confirmation before any paid call.
- Pending confirmations expire after 5 minutes and are consumed atomically to reduce replay risk.

## Rate limiting

- Per Telegram user limit is enforced in SQLite-backed middleware.
- Limits default to `30` requests per minute and `100` requests per hour.
- The limiter is checked before command execution.

## Webhook and polling modes

- Polling mode is the default for local demos.
- Webhook mode is supported with `BOT_MODE=webhook`.
- When webhook mode is used, the bot can set a Telegram webhook secret token via `WEBHOOK_SECRET_TOKEN`.

## Known limitations

- SQLite is acceptable for local demos but is not ideal for horizontally scaled production deployments.
- Wallet secrets are encrypted at rest, but the process still decrypts them in memory when invoking AgentCash.
- Rate limiting is process-shared through SQLite on one instance, not globally distributed across multiple replicas.
- Router traffic to OpenAI or Anthropic is optional, but enabling it sends non-slash user text to that provider.
- AgentCash CLI stderr/stdout is kept out of normal logs, but upstream tooling behavior can still influence error messages.

## Before hosted production

- Move secret management to a managed KMS or HSM-backed service.
- Replace SQLite with a production database and a distributed rate limiter.
- Put webhook mode behind HTTPS with a fixed domain and set `WEBHOOK_SECRET_TOKEN`.
- Add structured audit logging and alerting around repeated payment failures and rate-limit abuse.
- Add stronger outbound network controls and sandboxing around the AgentCash CLI process.
- Add secret rotation procedures for the bot token, router API keys, and master encryption key.
