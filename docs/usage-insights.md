# Usage Insights / Spend Analytics

Spend analytics give you a live view of how your AgentCash wallet is being used — broken down by time period, skill, actor, and endpoint. This is the differentiating layer on top of the generic AgentCash skill: you see not just what was called but what it cost, who called it, and whether any blocks or anomalies occurred.

## Architecture

`SpendAnalyticsService` in `src/analytics/SpendAnalyticsService.ts` reads from existing tables (`transactions`, `quotes`, `policy_decisions`, `preflight_attempts`) and computes aggregates on demand. No new data is stored — analytics are derived views over the existing audit trail.

## Metrics

| Metric | Source | Description |
|--------|--------|-------------|
| `totalCentsToday` | `transactions` | Successful spend since midnight UTC today |
| `totalCentsLast7Days` | `transactions` | Successful spend over the last 7 days |
| `totalCentsLast30Days` | `transactions` | Successful spend over the last 30 days |
| `bySkill` | `transactions` | Spend and call count grouped by skill |
| `byActor` | `transactions` | Spend grouped by hashed actor ID (top 20) |
| `quoteApprovalRate` | `quotes` | `succeeded` / `total` quotes |
| `quoteDenialRate` | `quotes` + `policy_decisions` | Policy denials as a fraction of all attempts |
| `failedExecutionCount` | `transactions` | Transactions with `status = 'error'` |
| `replayAttemptCount` | `preflight_attempts` | Blocked duplicate requests |
| `avgEstimatedCents` | `transactions` | Average estimated cost (from quote) |
| `avgActualCents` | `transactions` | Average actual charged cost |
| `topEndpoints` | `transactions` | Top 5 endpoints by spend |
| `dailySeries` | `transactions` | Per-day spend time series |

Successful spend is defined as transactions with `status IN ('submitted', 'success')`. Failed transactions (`status = 'error'`) are counted separately in `failedExecutionCount`.

## Commands

### Telegram (private chat only)

| Command | Description |
|---------|-------------|
| `/spend` | 30-day overview: totals, approval rate, failures, skill breakdown |
| `/spend today` | Today's spend + by-skill breakdown |
| `/spend week` | 7-day spend + by-skill breakdown |
| `/spend skills` | Full skill breakdown for last 30 days |
| `/spend export` | CSV export of last 30 days (safe fields only) |

Private chat restriction: `/spend` is blocked in group chats and redirects the user to DM.

### Telegram (group chat — admin-only for detail)

| Command | Description |
|---------|-------------|
| `/groupwallet spend` | Group spend overview; admins see full detail, members see aggregate totals only |
| `/groupwallet spend users` | Per-member spend breakdown (admin only) |
| `/groupwallet spend skills` | Per-skill breakdown (all members) |
| `/groupwallet export` | CSV export (admin only) |

### Discord

| Command | Description |
|---------|-------------|
| `/ac spend today` | Today's spend for your user wallet (ephemeral) |
| `/ac spend week` | 7-day spend for your user wallet (ephemeral) |
| `/ac guild spend` | Guild wallet spend overview (admin only, ephemeral) |

## Privacy Model

- **Private user spend** is only shown in private chat / DM. The command handler rejects group contexts.
- **Group/guild spend detail** (per-user breakdown) requires admin role. Non-admins see only aggregate totals (today / 7-day / 30-day).
- **Actor display** uses the first 8 characters of the pre-hashed `telegram_id_hash`. Raw platform user IDs are never shown.
- **Export fields**: `date`, `skill`, `status`, `estimated_usdc`, `actual_usdc`, `request_hash`. No raw request payload, email address, private key, or platform user ID is included.

## Export Script

```
tsx scripts/export-spend.ts --wallet-id <id> [--days 30] [--format csv|json]
tsx scripts/export-spend.ts --group-id <id> [--days 30] [--format csv|json]
tsx scripts/export-spend.ts --wallet-id <id> --summary [--days 30]
```

Output goes to stdout. Redirect with `> spend.csv` or `> spend.json`.

### CSV format

```
date,skill,status,estimated_usdc,actual_usdc,request_hash
2026-04-25,research,success,0.0025,0.0023,a3f7b2c1...
2026-04-25,enrich,error,0.0100,0.0000,
```

### Included fields

| Field | Description |
|-------|-------------|
| `date` | Calendar date (UTC) of the transaction |
| `skill` | Skill name (`research`, `enrich`, `generate`) |
| `status` | Transaction status (`submitted`, `success`, `error`, etc.) |
| `estimated_usdc` | Quoted cost in USDC (4 decimal places) |
| `actual_usdc` | Actual charged cost in USDC (0 if failed) |
| `request_hash` | SHA-256 hash of the canonical request (not the raw request) |

### Excluded fields (privacy)

`telegram_user_id`, `telegram_id_hash`, `encrypted_private_key`, `canonical_request_json`, `request_summary`, `response_summary`, `email`, `prompt`.

## Database Indexes

`migrations/0004_spend_analytics.sql` adds:

- `transactions(wallet_id, created_at DESC)` — speeds up per-wallet analytics
- `preflight_attempts(wallet_id, created_at DESC)` — speeds up replay attempt queries

These are also added to `AppDatabase.initialize()` so new installations have them automatically.

## Demo

```
# Start a research call
/research what is the current Fed funds rate

# View spend immediately after
/spend today
```

Example output:
```
Today's spend
Today: $0.0023

By skill:
  research    $0.0023   1 call
```
