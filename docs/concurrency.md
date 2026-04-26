# Concurrency

## Lock Layers

The app now has a `LockManager` abstraction in `src/locks/LockManager.ts`.

| Lock manager | Status | Use |
|---|---|---|
| `LocalLockManager` | In-process only. | Local development and single-process demos. |
| `RedisLockManager` | Uses `SET NX PX` with a unique token and compare-and-delete Lua release. | Multi-instance coordination aid. |

Config:

```bash
LOCK_PROVIDER=local
REDIS_URL=
ALLOW_LOCAL_LOCKS_IN_PRODUCTION=false
```

`NODE_ENV=production` rejects local locks unless `ALLOW_LOCAL_LOCKS_IN_PRODUCTION=true`.

## Redis Rules

Redis locks:

- use a unique ownership token
- require a TTL
- release only if the stored token matches
- fail closed if Redis acquisition or release is uncertain

There is no lock renewal yet. Long paid executions must keep the TTL comfortably above worst-case execution time or add renewal before production use.

This is not a claim that Redis locking or Redlock-style coordination is perfect. Redis is a coordination layer, not the source of truth.

## DB Idempotency

Paid execution is guarded in the database:

- Quote approval is an atomic `pending -> approved` transition.
- Paid execution must win an atomic `approved -> executing` transition.
- Completion is `executing -> succeeded`.
- Failure is `executing -> failed`.
- Transaction rows have a unique `idempotency_key`.

Only one worker can move a quote into `executing`. A replayed button click or second app instance cannot create a second paid execution for the same quote id.

## Quote Status Machine

Valid transitions:

- `pending -> approved`
- `pending -> expired`
- `pending -> canceled`
- `approved -> executing`
- `approved -> expired`
- `approved -> canceled`
- `executing -> succeeded`
- `executing -> failed`

Terminal states:

- `succeeded`
- `failed`
- `expired`
- `canceled`

## Remaining Risks

- Redis lock renewal is not implemented.
- If a process crashes after the paid call succeeds but before DB completion, the quote can remain `executing` and needs reconciliation.
- Postgres repository wiring is not complete yet; SQLite cannot provide multi-instance production guarantees.
- External payment APIs still need their own idempotency support where available.
- Operators need monitoring for stuck `executing` quotes and repeated lock failures.
