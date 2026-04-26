import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import { ConfigError } from "../lib/errors.js";
import { AppDatabase } from "./client.js";

export interface DatabaseAdapter {
  readonly provider: "sqlite" | "postgres";
  initialize(): void | Promise<void>;
  close(): void | Promise<void>;
}

export class SQLiteAdapter extends AppDatabase implements DatabaseAdapter {
  readonly provider = "sqlite" as const;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly provider = "postgres" as const;
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async initialize(): Promise<void> {
    await this.runMigrations();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      const migrationsDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "migrations"
      );
      const migrations = fs
        .readdirSync(migrationsDir)
        .filter(file => file.endsWith("_postgres.sql"))
        .sort();

      for (const file of migrations) {
        const version = file.replace(/_postgres\.sql$/, "");
        const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
        if (existing.rowCount) {
          continue;
        }

        await client.query(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createDatabaseAdapter(config: AppConfig): DatabaseAdapter {
  if (config.DATABASE_PROVIDER === "postgres") {
    if (!config.DATABASE_URL) {
      throw new ConfigError("DATABASE_URL is required when DATABASE_PROVIDER=postgres");
    }
    return new PostgresAdapter(config.DATABASE_URL);
  }

  return new SQLiteAdapter(config.DATABASE_PATH);
}
