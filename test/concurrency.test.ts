import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { PostgresAdapter } from "../src/db/DatabaseAdapter.js";
import { AppDatabase } from "../src/db/client.js";
import { LockUnavailableError } from "../src/lib/errors.js";
import { RedisLockManager, type RedisLockClient } from "../src/locks/LockManager.js";

const MASTER_KEY = Buffer.alloc(32, 99).toString("base64");

function seedApprovedQuote(db: AppDatabase): string {
  const user = db.upsertUser({ telegramUserId: "123", defaultSpendCapUsdc: 0.5 });
  const wallet = db.createUserWallet(user.id, {
    homeDirHash: "home-hash",
    address: "0xABC",
    encryptedPrivateKey: "encrypted",
    status: "active"
  });
  const quote = db.createQuote({
    userHash: "user-hash",
    walletId: wallet.id,
    skill: "research",
    endpoint: "https://example.test",
    canonicalRequestJson: "{}",
    requestHash: "request-hash",
    quotedCostCents: 1,
    maxApprovedCostCents: 50,
    isDevUnquoted: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requesterUserId: user.id
  });
  expect(db.atomicApproveQuote(quote.id)).toBe(true);
  return quote.id;
}

class FakeRedisClient implements RedisLockClient {
  isOpen = true;
  readonly values = new Map<string, string>();
  fail = false;

  async connect(): Promise<void> {
    if (this.fail) {
      throw new Error("redis down");
    }
    this.isOpen = true;
  }

  async set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null> {
    void options;
    if (this.fail) {
      throw new Error("redis down");
    }
    if (this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return "OK";
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
    if (this.fail) {
      throw new Error("redis down");
    }
    const [key] = options.keys;
    const [token] = options.arguments;
    if (key && this.values.get(key) === token) {
      this.values.delete(key);
      return 1;
    }
    return 0;
  }
}

describe("distributed execution idempotency", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("two DB connections can only move one approved quote into executing", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "agentcash-concurrency-"));
    const dbPath = path.join(tempDir, "agentcash.db");
    const db1 = new AppDatabase(dbPath);
    db1.initialize();
    const quoteId = seedApprovedQuote(db1);

    const db2 = new AppDatabase(dbPath);
    db2.initialize();

    const results = await Promise.all([
      Promise.resolve(db1.atomicBeginQuoteExecution(quoteId)),
      Promise.resolve(db2.atomicBeginQuoteExecution(quoteId))
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    db1.close();
    db2.close();
  });

  it("quote status transitions reject invalid jumps", () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const quoteId = seedApprovedQuote(db);

    expect(db.transitionQuoteStatus(quoteId, "approved", "succeeded")).toBe(false);
    expect(db.transitionQuoteStatus(quoteId, "approved", "executing")).toBe(true);
    expect(db.transitionQuoteStatus(quoteId, "executing", "succeeded")).toBe(true);
    expect(db.transitionQuoteStatus(quoteId, "succeeded", "failed")).toBe(false);

    db.close();
  });

  it("transaction idempotency keys are unique", () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const user = db.upsertUser({ telegramUserId: "123", defaultSpendCapUsdc: 0.5 });

    db.createTransaction({
      userId: user.id,
      telegramChatId: "chat",
      commandName: "research",
      status: "submitted",
      idempotencyKey: "quote:abc:execute"
    });

    expect(() =>
      db.createTransaction({
        userId: user.id,
        telegramChatId: "chat",
        commandName: "research",
        status: "submitted",
        idempotencyKey: "quote:abc:execute"
      })
    ).toThrow();

    db.close();
  });
});

describe("Redis locks", () => {
  it("release cannot delete another owner's lock", async () => {
    const client = new FakeRedisClient();
    const lockManager = new RedisLockManager(client);
    const owner = await lockManager.acquire("quote:1", 1000);

    await lockManager.release({ key: owner.key, token: "wrong-owner" });
    expect(client.values.size).toBe(1);

    await lockManager.release(owner);
    expect(client.values.size).toBe(0);
  });

  it("Redis unavailable fails closed before paid execution", async () => {
    const client = new FakeRedisClient();
    client.fail = true;
    const lockManager = new RedisLockManager(client);

    await expect(lockManager.withLock("quote:1", 1000, async () => "paid")).rejects.toThrow(
      LockUnavailableError
    );
  });
});

describe("database provider config", () => {
  it("production rejects SQLite unless explicitly overridden", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        DATABASE_PROVIDER: "sqlite",
        LOCK_PROVIDER: "redis",
        REDIS_URL: "redis://localhost:6379",
        CUSTODY_MODE: "remote_signer",
        REMOTE_SIGNER_URL: "https://signer.example",
        MASTER_ENCRYPTION_KEY: MASTER_KEY
      })
    ).toThrow(/DATABASE_PROVIDER=postgres/);
  });

  it("Postgres adapter can run migrations when DATABASE_URL is provided", async () => {
    if (!process.env.DATABASE_URL) {
      expect(process.env.DATABASE_URL).toBeUndefined();
      return;
    }

    const adapter = new PostgresAdapter(process.env.DATABASE_URL);
    await adapter.initialize();
    await adapter.close();
  });
});
