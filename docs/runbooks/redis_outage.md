# Redis Outage

## Symptoms

- `/readyz` lock check fails.
- Paid execution fails closed with lock unavailable errors.
- No new paid calls execute, but `/healthz` remains OK.

## Immediate Mitigation

- Do not switch to local locks in production.
- Keep the app degraded until Redis is restored.
- Communicate that paid execution is paused.

## Commands / Env Changes

```bash
LOCK_PROVIDER=redis
REDIS_URL=redis://redis:6379
docker compose ps redis
```

## Data To Preserve

- Redis service logs.
- App lock failure logs.
- Quotes left in `approved` or `executing`.

## Recovery

- Restore Redis.
- Check `/readyz`.
- Review stuck quotes before retrying paid calls.

## Postmortem Notes

- Add alerting on lock failure rate.
- Review TTL sizing and missing renewal risk.
