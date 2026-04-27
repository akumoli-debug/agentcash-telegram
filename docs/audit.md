# Audit

Audit logging has two layers:

1. `audit_events` in the runtime database is the source of truth.
2. `AuditOutboxWorker` ships unshipped `audit_events` rows to the configured external sink when `AUDIT_SINK=file` or `AUDIT_SINK=http`.

The app does not write sensitive command output directly to an external sink from command handlers. Command and execution paths write one DB audit row, then the outbox worker redacts and ships that row asynchronously.

## Configuration

```bash
AUDIT_SINK=database
AUDIT_STRICT_MODE=false
AUDIT_FILE_PATH=.data/audit-events.jsonl
AUDIT_HTTP_ENDPOINT=
ALLOW_DATABASE_AUDIT_IN_PRODUCTION=false
```

Modes:

| Setting | Behavior |
| --- | --- |
| `AUDIT_SINK=database` | Store audit events only in `audit_events`. No outbox worker starts. |
| `AUDIT_SINK=file` | Store audit events in DB, then append sanitized JSONL copies to `AUDIT_FILE_PATH`. |
| `AUDIT_SINK=http` | Store audit events in DB, then POST sanitized JSON copies to `AUDIT_HTTP_ENDPOINT`. |
| `AUDIT_STRICT_MODE=false` | Shipping failures increment attempt metadata but do not block paid execution or readiness. |
| `AUDIT_STRICT_MODE=true` | `/readyz` checks the configured sink and fails if the sink cannot accept audit events. |

Production config rejects `AUDIT_SINK=database` unless `ALLOW_DATABASE_AUDIT_IN_PRODUCTION=true` is explicitly set. Database-only audit is useful for local demos, but it is not enough for production evidence.

## Outbox Columns

`audit_events` includes shipping metadata:

- `shipped_at` — set when the configured external sink accepts the event.
- `ship_attempts` — incremented after a failed ship attempt.
- `last_ship_error` — last safe error message, truncated for storage.
- `sink_name` — sink attempted or used for the event.

The worker only polls rows with `shipped_at IS NULL`, so already shipped events are not shipped again by normal operation.

## Redaction

The worker calls the same audit sanitizer used by `FileAuditSink` and `HTTPAuditSink` before shipping. Metadata keys containing sensitive fragments are replaced with `[REDACTED]`, including:

- `private`
- `secret`
- `token`
- `raw`
- `prompt`
- `email`
- `telegram`
- `discord`
- `platformid`
- `apiresponse`

Nested objects and unknown structured values are also redacted instead of serialized.

## Failure Model

Audit shipping is best-effort by default. If the external sink fails, paid execution remains decoupled from the sink and the DB row remains unshipped for later retries. The row records `ship_attempts`, `last_ship_error`, and `sink_name`.

Set `AUDIT_STRICT_MODE=true` when deployment readiness should depend on the external audit sink. Strict mode does not make every paid call synchronously wait for the sink; it makes `/readyz` fail when the configured sink cannot accept events so orchestration can keep the instance out of service.

## Remaining Limitations

- No immutable audit store is bundled.
- No ship-failure alerting is bundled.
- No retention or archival policy is enforced by the app.
- Multiple app instances can each run an outbox worker; there is no cross-process claim/lease column yet, so a race could double-ship an event before one worker records `shipped_at`.
- HTTP sink authentication and signing are not implemented.
