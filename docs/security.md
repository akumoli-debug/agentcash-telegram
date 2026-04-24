# Security Model

This document describes the actual security posture honestly. It does not overclaim.

**This is a quote-bound, spend-controlled MVP Telegram surface for AgentCash. It is designed to demonstrate safe payment UX and per-user wallet isolation. Hosted production would require deeper custody review, a managed KMS, and a production-grade database.**

---

## Payment integrity model

Every paid call must satisfy all of the following before execution:

1. AgentCash CLI returned a bounded cost estimate for the exact request.
2. The user saw or implicitly accepted the quoted cost.
3. The exact approved request (stored as canonical JSON) is the one executed — not re-parsed user input.
4. The quote has not expired.
5. The selected wallet balance covers the quoted cost.
6. The call is within the user or group confirmation cap and the hard MVP safety cap.
7. The execution attempt is durably logged in `preflight_attempts`.

If any of these are false, the call fails safely. The failure is logged in `preflight_attempts`.

If `ALLOW_UNQUOTED_DEV_CALLS=true`, calls may proceed without a bounded quote — but are marked `dev_unquoted=1` in the `quotes` table and are never presented as production-safe.

---

## Quote record model

Before any confirmation or execution, a `quotes` record is created with:

- `user_hash` — keyed HMAC of the Telegram ID (not the raw ID)
- `canonical_request_json` — stable JSON of the request body (sorted keys)
- `request_hash` — HMAC of the canonical request
- `quoted_cost_cents` — cost from AgentCash CLI check
- `max_approved_cost_cents` — ceiling enforced at the DB layer
- `status` — `pending → approved → executed` (or `expired / cancelled / failed`)
- `expires_at` — immutable TTL set at creation
- `requester_user_id` and optional `group_id` — durable requester and group context
- `requires_group_admin_approval` — whether owner/admin approval is required

Confirmation atomically transitions `pending → approved` via:

```sql
UPDATE quotes SET status='approved', approved_at=? WHERE id=? AND status='pending' AND expires_at > ?
```

If 0 rows are changed, the confirm is rejected (replay protection). Execution then transitions `approved → executed`. Both the per-user in-memory lock and the SQL check protect against concurrent double-execution.

---

## Wallet isolation model

- Each Telegram user gets a distinct AgentCash wallet context.
- Each Telegram group wallet gets a distinct AgentCash wallet context using `wallets.kind='group'`.
- Wallet home directories are named `<AGENTCASH_HOME_ROOT>/<user_hash>/` where `user_hash` is a keyed HMAC of the Telegram ID — never the raw Telegram ID.
- Group wallet home directories are named with a keyed HMAC of the chat ID, not the raw chat ID.
- SQLite stores wallet metadata. Private key material is encrypted at rest with AES-256-GCM using `MASTER_ENCRYPTION_KEY`.
- Wallet provisioning is idempotent: if the wallet row exists and is active, the CLI is not called again.
- If a new encrypted key is returned from the CLI but a different key already exists in the database, provisioning refuses with an error rather than silently overwriting.

### AgentCash CLI dependency risk

All CLI interactions are encapsulated in `agentcashClient.ts`. The CLI runs as a subprocess in the user's isolated home directory. This is the main operational risk:

- If the CLI is unavailable, startup fails with a clear error.
- CLI errors can surface in application error messages.
- The CLI must be trusted — it receives the decrypted wallet private key via environment variable.
- Key material is present in process memory only during CLI invocation.

---

## PII minimization

Product, payment, and audit tables (`wallets`, `transactions`, `quotes`, `preflight_attempts`) contain:

- `user_hash` — keyed HMAC-SHA256 of the Telegram user ID (24 hex chars)
- `telegram_chat_id_hash` for group records, keyed HMAC-SHA256 of the Telegram chat ID
- No usernames, first names, or last names

The only table that stores raw Telegram user IDs is `delivery_identities`, which maps `user_hash → telegram_user_id` for session/callback routing. This table is isolated from payment data.

The `users` table stores `telegram_user_id` for session lookup but no personal name fields.

`telegram_chat_id` in `transactions` rows stores the hashed chat ID, not the raw value.

`groups.title_hash` stores a keyed hash of the group title when Telegram provides one.

---

## Preflight failure logging

Failed attempts are recorded in `preflight_attempts` with:

- `user_hash`
- `wallet_id` if available
- `skill`
- `failure_stage`: `wallet | balance | quote | cap | execution | replay | expired`
- `error_code`
- `safe_error_message`

No raw request bodies or user input is logged.

---

## Logging model

- No raw private keys, signed payloads, or raw API responses are logged.
- Transaction logging stores request and response hashes only.
- Structured `audit_events` record wallet/quote/payment lifecycle events without raw payloads or raw responses.
- Telegram identifiers are hashed before logging.
- Pino redaction covers: private keys, encrypted inputs, session state JSON, API keys, webhook secrets, raw CLI output fields.

---

## Spending caps

- Default per-call confirmation cap: `$0.50` (configurable via `/cap`)
- Hard MVP ceiling: `$5.00` unless `ALLOW_HIGH_VALUE_CALLS=true`
- Natural-language routed calls always require explicit confirmation regardless of cap.
- Cap denials are logged in `preflight_attempts`.
- In group chats, members may request calls under the group cap. Over-cap group calls require owner/admin confirmation.

---

## Rate limiting

- Per Telegram user, enforced in SQLite-backed middleware: 30/minute and 100/hour (configurable).
- Process-local; not distributed across multiple replicas.

---

## Replay and concurrency protection

- The `LockManager` interface serializes wallet provisioning, quote approval, and paid execution.
- The default `LocalLockManager` is in-process only.
- Group wallet provisioning uses a per-group in-memory lock.
- SQL-level atomic approve prevents double-execution even under concurrent callbacks.
- Session state stores only `quote_id`, not raw input. Confirm handler verifies the quote ID matches the session before proceeding.
- Group confirmations authorize against the immutable quote's stored `group_id`, requester, and over-cap approval flag.
- Inline start payloads are HMAC-signed, single-use, and expire after 5 minutes. They can only route into the normal quote/confirmation flow.
- Discord slash commands use the same quote records and confirmation state as Telegram; wallet-sensitive Discord responses are ephemeral.

---

## Group custody risks

Group wallets concentrate shared funds under one bot-controlled wallet. Current safeguards:

- Group wallet creation is idempotent and uses `wallets.kind='group'`.
- Raw Telegram chat IDs are hashed in group records.
- Transactions record the acting requester user and the group wallet.
- Non-admin members cannot change the group cap.
- Over-cap quotes cannot be confirmed by arbitrary members.

Important limitations:

- Telegram admin status is not synced automatically.
- Only the creator becomes owner automatically; additional admins require a future role-management workflow or direct database update.
- Owner/admin approval is enforced, but there is no full approval queue or quorum policy yet.
- Any owner/admin can approve an over-cap call, so groups should keep low caps until role management is expanded.

---

## Known limitations and honest caveats

| Risk | Current state |
|---|---|
| SQLite | Local only. Not suitable for distributed production. |
| LocalLockManager | Per-process only. Multiple replicas = no cross-process locking. |
| CLI subprocess trust | The CLI is trusted. It receives the decrypted private key. |
| Key material in memory | Decrypted during CLI invocations. Not zeroed after use. |
| `MASTER_ENCRYPTION_KEY` rotation | No rotation procedure exists. |
| AgentCash CLI availability | If the CLI is broken or unavailable, no paid calls can proceed. |
| Router traffic | If NL routing is enabled, non-slash user text is sent to OpenAI or Anthropic. |
| Group role sync | Telegram admin status is not synced; only the creator is owner automatically. |
| Discord guild wallets | Not enabled in the MVP. Guild channels return a limitation message instead of using a user wallet implicitly. |
| Docker scaffold | Helpful for staging-like demos, not a custody boundary. |

---

## Before hosted production

- Move key management to a managed KMS or HSM-backed service.
- Replace SQLite with a production database and implement a distributed lock with TTL, ownership token, and safe release.
- Use webhook mode with HTTPS and `WEBHOOK_SECRET_TOKEN`.
- Add structured audit log shipping and alerting for repeated payment failures.
- Add sandboxing around the AgentCash CLI process (e.g., seccomp, network restrictions).
- Implement key rotation procedures for bot token, API keys, and master encryption key.
- Review custody model — this MVP assumes the operator can access all wallet keys.
