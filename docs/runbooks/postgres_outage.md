# Future Postgres Outage

Postgres is not the current runtime repository. This runbook is a future-production placeholder for the point after the Postgres runtime adapter is implemented and tested. Today, Postgres is only a migration scaffold.

## Current Scaffold Symptoms

- `corepack pnpm db:migrate` fails against a Postgres URL.
- `docker compose --profile postgres-scaffold up` cannot start the local scaffold service.

## Future Runtime Symptoms

- `/readyz` database check fails.
- Bot commands fail to read or write wallet/quote state.
- Audit events stop persisting.

## Immediate Mitigation After Runtime Support Exists

- Do not fall back to SQLite in production.
- Stop paid execution until DB durability returns.
- Preserve app logs for failed writes.

## Scaffold Commands

```bash
docker compose --profile postgres-scaffold up
DATABASE_PROVIDER=postgres DATABASE_URL=postgres://agentcash:agentcash@localhost:5432/agentcash corepack pnpm db:migrate
```

## Data To Preserve After Runtime Support Exists

- Postgres logs.
- Last successful backup.
- App logs and audit sink output.

## Recovery After Runtime Support Exists

- Restore Postgres service or fail over.
- Run migrations.
- Check `/readyz`.
- Reconcile quotes in `executing`.

## Postmortem Notes

- Record recovery point and recovery time.
- Verify backup restore drills.
