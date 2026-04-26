import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";

const config = parseConfig(process.env);
const db = new AppDatabase(config.DATABASE_PATH);

try {
  db.initialize();
  const rows = db.listStuckExecutions(100).map(row => ({
    quote_id: row.id,
    wallet_id: row.wallet_id,
    skill: row.skill,
    request_hash: row.request_hash,
    status: row.status,
    execution_started_at: row.execution_started_at,
    execution_lease_expires_at: row.execution_lease_expires_at,
    execution_attempt_count: row.execution_attempt_count,
    last_execution_error: row.last_execution_error,
    upstream_idempotency_key: row.upstream_idempotency_key,
    reconciliation_status: row.reconciliation_status,
    transaction_id: row.transaction_id,
    created_at: row.created_at
  }));
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} finally {
  db.close();
}
