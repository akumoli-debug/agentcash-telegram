# Execution Reconciliation

Paid execution is quote-first and lease-based. The database quote row is the source of truth for local execution state.

## State Machine

```text
pending -> approved -> executing -> succeeded
pending -> approved -> executing -> execution_unknown
pending -> approved -> executing -> failed
pending -> expired
pending -> canceled
```

`execution_unknown` means the app cannot safely prove whether the upstream paid call completed. Operators must review the wallet, AgentCash records, and transaction evidence before deciding what happened.

## Execution Fields

`quotes` includes execution recovery fields:

- `execution_started_at`
- `execution_lease_expires_at`
- `execution_attempt_count`
- `last_execution_error`
- `upstream_idempotency_key`
- `reconciliation_status`
- `reconciled_at`

Before execution starts, the app atomically moves the quote from `pending` or `approved` to `executing`, sets a lease expiry, increments `execution_attempt_count`, and stores a deterministic `upstream_idempotency_key`.

The upstream key is derived from:

```text
quote_id + wallet_id + request_hash
```

The app passes that key through the `AgentCashClient.fetchJson` boundary. The current local AgentCash CLI wrapper does not expose a documented idempotency header or option, so this repo must treat upstream idempotency as not guaranteed. That is a serious production limitation.

## Success

After a successful AgentCash fetch and result formatting:

1. A `transactions` row is written with the same idempotency key.
2. The quote transitions `executing -> succeeded`.
3. The execution lease is cleared.

## Ambiguous Failure

If anything fails after the quote enters `executing`, the app does not automatically retry the paid call. It transitions the quote to `execution_unknown`, stores a safe `last_execution_error`, and requires operator review.

Known-safe failures before execution, such as quote/check failure, balance failure, cap failure, or expired confirmation, still fail before the paid call path.

## Reconciler

`src/workers/executionReconciler.ts` finds quotes where:

```sql
status = 'executing'
AND execution_lease_expires_at <= now
```

For each expired execution lease:

- If a local transaction exists for the quote, the reconciler marks the quote `succeeded`.
- If no local transaction exists and upstream reconciliation is unavailable, the reconciler marks the quote `execution_unknown`.
- It never retries a paid call automatically because upstream idempotency is not guaranteed by the current CLI wrapper.

## Operator Scripts

List stuck or unknown executions without raw prompts/bodies:

```bash
corepack pnpm exec tsx scripts/list-stuck-executions.ts
```

Mark an `execution_unknown` quote reviewed after operator investigation:

```bash
corepack pnpm exec tsx scripts/mark-execution-reviewed.ts <quote_id>
```

Script output includes quote id, wallet id, skill, request hash, execution timestamps, safe error text, upstream idempotency key, reconciliation status, and transaction id. It does not include raw prompt or request body.

## Remaining Limitations

- No upstream AgentCash reconciliation query is implemented.
- No documented AgentCash CLI idempotency option is available in this wrapper.
- No automatic retry is allowed without guaranteed upstream idempotency.
- The reconciler is available as code and operator tooling, but it is not yet a continuously scheduled production worker.
