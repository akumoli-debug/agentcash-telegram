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
6. The call is within the user or group per-call cap and the hard MVP safety cap.
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
- `max_approved_cost_cents` — approved quote ceiling stored with the quote for audit and execution policy checks
- `status` — `pending → approved → executing → succeeded` (or `execution_unknown / expired / canceled / failed`)
- `expires_at` — immutable TTL set at creation
- `execution_started_at`, `execution_lease_expires_at`, `execution_attempt_count`, `last_execution_error`, `upstream_idempotency_key`, `reconciliation_status`, `reconciled_at` — recovery metadata for ambiguous paid execution outcomes
- `requester_user_id` and optional `group_id` — durable requester and group context
- `requires_group_admin_approval` — whether owner/admin approval is required

Confirmation atomically transitions `pending → approved` via:

```sql
UPDATE quotes SET status='approved', approved_at=? WHERE id=? AND status='pending' AND expires_at > ?
```

If 0 rows are changed, the confirm is rejected (replay protection). Execution then transitions `approved → executing → succeeded` or `execution_unknown`. Both the per-user lock and the SQL check protect against concurrent double-execution.

---

## Wallet isolation model

- Each Telegram user gets a distinct AgentCash wallet context.
- Telegram user-wallet commands are private-chat only: `/start`, `/deposit`, `/balance`, `/cap`, `/history`, `/research`, `/enrich`, and `/generate` refuse group, supergroup, and channel execution.
- If a private-wallet command is attempted in a group, the bot replies only: `For private wallet commands, DM me directly. In this group, use /groupwallet help.`
- User-wallet deposit addresses, balances, and history details are never posted to Telegram groups. Group chats must use `/groupwallet` commands for shared wallet operations.
- Telegram natural-language routing is private-chat only. Group text is not routed to paid user-wallet skills.
- Wallet home directories are named `<AGENTCASH_HOME_ROOT>/<user_hash>/` where `user_hash` is a keyed HMAC of the Telegram ID — never the raw Telegram ID.
- Experimental roadmap group wallet home directories are named with a keyed HMAC of the chat ID, not the raw chat ID.
- SQLite stores wallet metadata. Local/demo private key material is encrypted at rest with AES-256-GCM using `MASTER_ENCRYPTION_KEY`.
- Wallet rows include custody metadata: `wallet_ref`, `signer_backend`, `public_address`, and `active_key_version`.
- Wallet provisioning is idempotent: if the wallet row exists and is active, the CLI is not called again.
- If a new encrypted key is returned from the CLI but a different key already exists in the database, provisioning refuses with an error rather than silently overwriting.

---

## Custody boundary

Custody is abstracted behind `src/custody/signer.ts`.

| Mode | Status |
|---|---|
| `local_cli` | Demo only. Wraps current AgentCash CLI behavior and isolates decrypted key env passing inside `LocalCliSigner`. |
| `local_encrypted` | Experimental local boundary; not production-intended. |
| `remote_signer` | Future production path for a separate signer service. |
| `kms` | Future KMS/HSM path; currently fails closed with a clear error. |

Production startup rejects `CUSTODY_MODE=local_cli` unless `ALLOW_INSECURE_LOCAL_CUSTODY=true` is explicitly set and a large warning is logged. Production also rejects `local_encrypted`.

`AgentCashClient` does not import key decrypt helpers. It can still execute the CLI only when the signer backend is `LocalCliSigner`.

---

## Telegram-admin-gated group wallets

Group wallets are experimental but no longer rely only on first-writer database roles.

Admin-sensitive group wallet actions require both:

1. Internal `group_members.role IN ('owner', 'admin')`.
2. Fresh Telegram verification that the actor is currently `creator` or `administrator`.

Fresh verification is stored in `telegram_admin_verifications` with:

- `group_id`
- `user_id`
- `verified_at`
- `telegram_status`
- `expires_at`
- `source`

The freshness window is 5 minutes. Stale internal roles are not enough to change group caps or approve over-cap group wallet quotes.

Telegram statuses are interpreted as:

- `creator`: admin
- `administrator`: admin
- `member`, `restricted`, `left`, `kicked`: not admin

If Telegram verification fails, the action fails closed and tells the user to make the bot a group admin. The app does not silently allow admin actions when Telegram cannot be checked.

### AgentCash CLI dependency risk

All demo CLI key handling is isolated in `LocalCliSigner`. The CLI runs as a subprocess in the user's isolated home directory. This is the main operational risk:

- If the CLI is unavailable, startup fails with a clear error.
- Raw CLI stdout/stderr are not included in structured errors because they could contain sensitive data.
- The CLI must be trusted — it receives the decrypted wallet private key via environment variable.
- Key material is present in process memory only during CLI invocation.

---

## PII minimization

Product, payment, and audit tables (`wallets`, `transactions`, `quotes`, `preflight_attempts`) contain:

- `user_hash` — keyed HMAC-SHA256 of the Telegram user ID (24 hex chars)
- `telegram_chat_id_hash` for group records, keyed HMAC-SHA256 of the Telegram chat ID
- No usernames, first names, or last names

The only table that stores raw Telegram user IDs is `delivery_identities`, which maps `user_hash → telegram_user_id` for session/callback routing. This table is isolated from payment data.

The `users` table stores `telegram_user_id` for session lookup and has nullable legacy name columns, but current command paths do not populate usernames, first names, or last names.

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
- When `AUDIT_SINK=file` or `AUDIT_SINK=http`, an audit outbox worker ships sanitized copies from `audit_events` to the configured external sink and records `shipped_at`, `ship_attempts`, `last_ship_error`, and `sink_name`.
- Telegram identifiers are hashed before logging.
- Pino redaction covers: private keys, encrypted inputs, session state JSON, API keys, webhook secrets, raw CLI output fields.

---

## Spending caps

- Default per-call cap: `$0.50` (configurable via `/cap`)
- Hard MVP ceiling: `$5.00` unless `ALLOW_HIGH_VALUE_CALLS=true`
- Natural-language routed calls always require explicit confirmation regardless of cap.
- Cap denials are logged in `preflight_attempts`.

---

## Rate limiting

- Per Telegram user, enforced in SQLite-backed middleware: 30/minute and 100/hour (configurable).
- Process-local; not distributed across multiple replicas.

---

## Replay and concurrency protection

- The `LockManager` interface serializes wallet provisioning, quote approval, and paid execution.
- The default `LocalLockManager` is in-process only.
- SQL-level atomic approve prevents double-execution even under concurrent callbacks.
- Paid execution also requires an atomic `pending/approved -> executing` quote transition, an execution lease, and a deterministic upstream idempotency key. The current AgentCash CLI wrapper does not document upstream idempotency support, so the app never retries an ambiguous paid call automatically.
- Session state stores only `quote_id`, not raw input. Confirm handler verifies the quote ID matches the session before proceeding.
- User-wallet quote confirmations must happen in a private chat by the original requester. Group-wallet quote confirmations may happen in the matching Telegram group only, and over-cap group confirmations require an owner/admin with fresh Telegram admin verification.
- Group wallets, inline mode, and Discord are experimental code paths and are not part of the shipped Telegram private-chat MVP demo.

---

## Group custody risks

Group wallets are not part of the shipped private-chat MVP demo. They concentrate shared funds under one bot-controlled wallet. Current experimental safeguards:

- Group wallet creation is idempotent and uses `wallets.kind='group'`.
- Raw Telegram chat IDs are hashed in group records.
- Transactions record the acting requester user and the group wallet.
- Non-admin members cannot create the group wallet, change the group cap, or approve over-cap quotes.
- Telegram admin status gates group wallet creation and high-risk admin actions.
- `/groupwallet sync-admins` promotes/demotes local roles from Telegram's current admin list.

Important limitations:

- Telegram admin status is synced on command, not continuously in the background.
- Telegram admins who have never interacted with the bot may be counted but cannot be mapped to an internal user row yet.
- Owner/admin approval is enforced, but there is no full approval queue or quorum policy.
- Any owner/admin can approve an over-cap call, so groups should keep low caps until role management is expanded.

---

## Known limitations and honest caveats

| Risk | Current state |
|---|---|
| SQLite | Local only. Not suitable for distributed production. |
| Postgres adapter | Migration/adapter exists, but full repository wiring is not complete. |
| LocalLockManager | Per-process only. Multiple replicas = no cross-process locking. |
| RedisLockManager | Coordination aid only. No lock renewal yet, and DB idempotency remains the source of truth. |
| `local_cli` custody | Demo only. The CLI is trusted and receives the decrypted private key through `LocalCliSigner`. |
| Key material in memory | Decrypted during local CLI invocations. Not zeroed after use. |
| Remote signer/KMS | Interfaces and stubs exist, but no production signer is implemented. |
| Key rotation | Local/demo key version audit exists; no automatic fund migration or production key rotation exists. |
| `MASTER_ENCRYPTION_KEY` rotation | No tested rotation procedure exists. |
| AgentCash CLI availability | If the CLI is broken or unavailable, no paid calls can proceed. |
| Router traffic | If NL routing is enabled, non-slash user text is sent to OpenAI or Anthropic. |
| Group role sync | Telegram admin status is command-synced, not continuously reconciled. |
| Discord guild wallets | Not enabled in the MVP. Guild channels return a limitation message instead of using a user wallet implicitly. |
| Docker scaffold | Helpful for staging-like demos, not a custody boundary. |

---

## Before hosted production

- Move key management to a remote signer or managed KMS/HSM-backed service.
- Replace SQLite with a production database and implement a distributed lock with TTL, ownership token, and safe release.
- Use webhook mode with HTTPS and `WEBHOOK_SECRET_TOKEN`.
- Add immutable audit storage, retention policy, and alerting for repeated payment failures or audit ship failures.
- Add sandboxing around any remaining AgentCash CLI process (e.g., seccomp, network restrictions).
- Implement key rotation procedures for wallet keys, bot token, API keys, and master encryption key.
- Review custody model — this MVP assumes the operator can access all wallet keys.
