# Database

## Providers

| Provider | Status | Use |
|---|---|---|
| `sqlite` | Fully used by the current app and test suite. | Local development, dry smoke, controlled demos. |
| `postgres` | Adapter and initial migration exist. Startup runs migrations, then fails closed because the synchronous repository methods still need full Postgres wiring. | Production target, not yet a production claim. |

SQLite remains the working local database. It is not a production database for this product because it is local to one host and does not provide the operational model needed for multi-instance bot workers.

## Config

```bash
DATABASE_PROVIDER=sqlite
DATABASE_PATH=.data/agentcash-telegram.db
DATABASE_URL=
ALLOW_SQLITE_IN_PRODUCTION=false
```

For Postgres migration testing:

```bash
DATABASE_PROVIDER=postgres
DATABASE_URL=postgres://user:pass@host:5432/agentcash
```

`NODE_ENV=production` rejects SQLite unless `ALLOW_SQLITE_IN_PRODUCTION=true`. That override is unsafe and should only be used to prove the guard works or run an explicitly non-production demo.

## Migrations

Migration files:

- `migrations/0001_initial_sqlite.sql`
- `migrations/0001_initial_postgres.sql`

Postgres migrations are applied by `PostgresAdapter.initialize()` and tracked in `schema_migrations`.

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

## Current Caveat

The production storage target is not yet fully wired into every repository method. The app refuses to start with `DATABASE_PROVIDER=postgres` after running migrations rather than silently falling back to SQLite.

Before claiming production storage, finish the repository adapter migration so all methods currently on `AppDatabase` execute through Postgres with transactional tests.
