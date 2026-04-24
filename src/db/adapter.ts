/**
 * Durable database boundary for a future production adapter.
 *
 * The current application uses AppDatabase (better-sqlite3) directly. This
 * interface is intentionally small until a Postgres migration is implemented
 * end to end with transactional tests, migrations, and deployment docs.
 */
export interface DatabaseAdapter {
  initialize(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface PostgresMigrationTodo {
  readonly reason: "sqlite-local-only";
  readonly tables: readonly string[];
}

export const postgresMigrationTodo: PostgresMigrationTodo = {
  reason: "sqlite-local-only",
  tables: [
    "users",
    "delivery_identities",
    "groups",
    "group_members",
    "wallets",
    "quotes",
    "transactions",
    "preflight_attempts",
    "audit_events",
    "inline_payloads",
    "sessions",
    "request_events"
  ]
};
