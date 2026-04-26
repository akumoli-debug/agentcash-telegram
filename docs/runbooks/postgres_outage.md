# Postgres Outage

## Symptoms

- `/readyz` database check fails.
- Bot commands fail to read or write wallet/quote state.
- Audit events stop persisting.

## Immediate Mitigation

- Do not fall back to SQLite in production.
- Stop paid execution until DB durability returns.
- Preserve app logs for failed writes.

## Commands / Env Changes

```bash
DATABASE_PROVIDER=postgres
DATABASE_URL=postgres://agentcash:agentcash@postgres:5432/agentcash
docker compose ps postgres
corepack pnpm db:migrate
```

## Data To Preserve

- Postgres logs.
- Last successful backup.
- App logs and audit sink output.

## Recovery

- Restore Postgres service or fail over.
- Run migrations.
- Check `/readyz`.
- Reconcile quotes in `executing`.

## Postmortem Notes

- Record recovery point and recovery time.
- Verify backup restore drills.
