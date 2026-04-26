# Database

## Providers

| Provider | Status | Use |
|---|---|---|
| `sqlite` | Fully used by the current app and test suite. | Local development, dry smoke, controlled demos. |
| `postgres` | Migration scaffold only. `PostgresAdapter` can run migrations, but the runtime repository methods are not implemented. App startup fails before partially starting when `DATABASE_PROVIDER=postgres`. | Future production DB target, not a current runtime option. |

SQLite remains the working local database. It is not a production database for this product because it is local to one host and does not provide the operational model needed for multi-instance bot workers.

## Config

```bash
DATABASE_PROVIDER=sqlite
DATABASE_PATH=.data/agentcash-telegram.db
DATABASE_URL=
ALLOW_SQLITE_IN_PRODUCTION=false
```

For Postgres migration scaffold testing:

```bash
DATABASE_PROVIDER=postgres
DATABASE_URL=postgres://user:pass@host:5432/agentcash
```

`NODE_ENV=production` rejects SQLite unless `ALLOW_SQLITE_IN_PRODUCTION=true`. That override is unsafe and should only be used to prove the guard works or run an explicitly non-production demo.

## Migrations

Migration files:

- `migrations/0001_initial_sqlite.sql`
- `migrations/0001_initial_postgres.sql`

Postgres migrations are applied by `PostgresAdapter.initialize()` and tracked in `schema_migrations`. This is a migration scaffold, not runtime repository support.

Migration commands:

```bash
corepack pnpm db:migrate
DATABASE_PROVIDER=postgres DATABASE_URL=postgres://user:pass@host:5432/agentcash corepack pnpm db:migrate
```

The migration covers:

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

`audit_events` is also the audit outbox source of truth. Rows include `shipped_at`, `ship_attempts`, `last_ship_error`, and `sink_name` so the worker can ship sanitized copies to file or HTTP sinks without losing the DB audit trail.

## Current Caveat

The future production DB target is not yet fully wired into every repository method. The app refuses to start with `DATABASE_PROVIDER=postgres` using this exact runtime guard:

```text
Postgres runtime adapter is not implemented yet. Use SQLite for local demo or implement PostgresAdapter before production.
```

Before claiming production storage, finish the repository adapter migration so all methods currently on `AppDatabase` execute through Postgres with transactional tests. See [postgres-adapter-plan.md](postgres-adapter-plan.md).
