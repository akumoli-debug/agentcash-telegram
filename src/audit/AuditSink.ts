import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import { ConfigError } from "../lib/errors.js";

export interface AuditEvent {
  eventName: string;
  walletId?: string | null;
  quoteId?: string | null;
  transactionId?: string | null;
  actorHash?: string | null;
  groupId?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void> | void;
}

export class DatabaseAuditSink implements AuditSink {
  constructor(private readonly db: Pick<AppDatabase, "createAuditEvent">) {}

  write(event: AuditEvent): void {
    this.db.createAuditEvent({
      eventName: event.eventName,
      walletId: event.walletId,
      quoteId: event.quoteId,
      transactionId: event.transactionId,
      actorHash: event.actorHash,
      groupId: event.groupId,
      status: event.status,
      metadata: sanitizeAuditMetadata(event.metadata ?? {})
    });
  }
}

export class FileAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  write(event: AuditEvent): void {
    const resolved = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${JSON.stringify(sanitizeAuditEvent(event))}\n`);
  }
}

export class HTTPAuditSink implements AuditSink {
  constructor(private readonly endpoint: string) {}

  async write(event: AuditEvent): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sanitizeAuditEvent(event))
    });

    if (!response.ok) {
      throw new ConfigError(`Audit sink HTTP write failed with status ${response.status}`);
    }
  }
}

export function createAuditSink(config: AppConfig, db: AppDatabase): AuditSink {
  if (config.AUDIT_SINK === "file") {
    return new FileAuditSink(config.AUDIT_FILE_PATH);
  }

  if (config.AUDIT_SINK === "http") {
    if (!config.AUDIT_HTTP_ENDPOINT) {
      throw new ConfigError("AUDIT_HTTP_ENDPOINT is required when AUDIT_SINK=http");
    }
    return new HTTPAuditSink(config.AUDIT_HTTP_ENDPOINT);
  }

  return new DatabaseAuditSink(db);
}

export function sanitizeAuditEvent(event: AuditEvent): AuditEvent {
  return {
    eventName: event.eventName,
    walletId: event.walletId ?? null,
    quoteId: event.quoteId ?? null,
    transactionId: event.transactionId ?? null,
    actorHash: event.actorHash ?? null,
    groupId: event.groupId ?? null,
    status: event.status ?? null,
    metadata: sanitizeAuditMetadata(event.metadata ?? {}),
    createdAt: event.createdAt ?? new Date().toISOString()
  };
}

export function sanitizeAuditMetadata(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveAuditKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string") {
      output[key] = value.length > 128 ? `${value.slice(0, 128)}...` : value;
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value;
      continue;
    }

    output[key] = "[REDACTED]";
  }

  return output;
}

function isSensitiveAuditKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return [
    "private",
    "secret",
    "token",
    "raw",
    "prompt",
    "email",
    "telegram",
    "discord",
    "platformid",
    "apiresponse"
  ].some(fragment => lowered.includes(fragment));
}
