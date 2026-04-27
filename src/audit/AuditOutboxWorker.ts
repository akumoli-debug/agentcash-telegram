import type { AppConfig } from "../config.js";
import type { AppDatabase, AuditEventRow } from "../db/client.js";
import type { AppLogger } from "../lib/logger.js";
import type { AuditEvent, AuditSink } from "./AuditSink.js";
import { sanitizeAuditEvent } from "./AuditSink.js";

export interface AuditOutboxWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
}

export class AuditOutboxWorker {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: Error | null = null;

  constructor(
    private readonly db: Pick<
      AppDatabase,
      "listUnshippedAuditEvents" | "markAuditEventShipped" | "markAuditEventShipFailed"
    >,
    private readonly sink: AuditSink,
    private readonly sinkName: AppConfig["AUDIT_SINK"],
    private readonly logger: Pick<AppLogger, "debug" | "warn">,
    options: AuditOutboxWorkerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
  }

  start(): void {
    if (this.interval) {
      return;
    }

    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const rows = this.db.listUnshippedAuditEvents(this.batchSize);
      for (const row of rows) {
        await this.shipRow(row);
      }
    } finally {
      this.running = false;
    }
  }

  async checkSinkHealth(): Promise<void> {
    await this.sink.write(
      sanitizeAuditEvent({
        eventName: "audit_sink_healthcheck",
        status: "ready",
        metadata: { sink: this.sinkName }
      })
    );
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  private async shipRow(row: AuditEventRow): Promise<void> {
    try {
      await this.sink.write(sanitizeAuditEvent(auditEventFromRow(row)));
      this.db.markAuditEventShipped(row.id, this.sinkName);
      this.lastError = null;
      this.logger.debug({ auditEventId: row.id, sinkName: this.sinkName }, "audit event shipped");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = error instanceof Error ? error : new Error(message);
      this.db.markAuditEventShipFailed(row.id, this.sinkName, message);
      this.logger.warn(
        { auditEventId: row.id, sinkName: this.sinkName, err: { message } },
        "audit event shipping failed"
      );
    }
  }
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
  return {
    eventName: row.event_name,
    walletId: row.wallet_id,
    quoteId: row.quote_id,
    transactionId: row.transaction_id,
    actorHash: row.actor_hash,
    groupId: row.group_id,
    status: row.status,
    metadata: parseAuditMetadata(row.metadata_json),
    createdAt: row.created_at
  };
}

function parseAuditMetadata(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
