# Postgres Adapter Plan

Postgres is currently a migration scaffold and future production DB target. It is not the runtime repository for bot commands yet.

## Tables to Port

The runtime repository must cover every table currently used by `AppDatabase`:

- `users`
- `delivery_identities`
- `wallets`
- `groups`
- `group_members`
- `telegram_admin_verifications`
- `quotes`
- `transactions`
- `sessions`
- `preflight_attempts`
- `audit_events`
- `inline_payloads`
- `key_versions`
- `wallet_keys`

## Adapter Methods to Implement

Implement a Postgres-backed equivalent for every synchronous repository method used by commands, wallet management, skill execution, locks/readiness, and audits. The current runtime surface includes user upsert/lookup, wallet CRUD, group wallet membership, session state, quote creation/status transitions, transaction history, preflight logging, audit logging, inline payload consume, key-version tracking, and rate-limit counters.

The migration should either:

- introduce an async repository interface and update callers intentionally, or
- provide a complete compatibility layer without silently falling back to SQLite.

## Transaction Semantics Needed

- Quote creation and confirmation must be transactional.
- `pending -> approved -> executing -> succeeded/failed` transitions must be atomic.
- Session-state consumption must be compare-and-swap.
- Wallet provisioning must be idempotent under concurrent requests.
- Inline payload consumption must be single-use.
- Audit/preflight writes must not expose raw payloads and should be best-effort only where safe.

## Idempotency Requirements

- `quotes.status` transitions must reject replay and invalid jumps.
- `transactions.idempotency_key` must remain unique.
- Confirm callbacks must execute a quote at most once under concurrent clicks.
- Group quote confirmation must verify the hashed group chat context.
- User-wallet confirmations must remain private-chat only.

## Tests Required

- Full existing test suite against SQLite.
- Full equivalent repository suite against Postgres.
- Migration idempotency tests.
- Concurrent quote approval and execution tests using two Postgres clients.
- Wallet provisioning race tests.
- Group-wallet membership and admin verification tests.
- History scoping tests for user and group wallets.
- Release-check coverage that prevents claiming Postgres runtime readiness before the adapter is complete.

## Done Criteria

- App startup with `DATABASE_PROVIDER=postgres` uses Postgres for every runtime repository method.
- No command path imports `AppDatabase` SQLite-only APIs directly.
- `/readyz` validates Postgres connectivity.
- Docker/deployment docs are updated from migration scaffold to supported runtime only after the full suite passes.
