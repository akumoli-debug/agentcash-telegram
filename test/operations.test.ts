import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import { FileAuditSink, HTTPAuditSink, sanitizeAuditEvent } from "../src/audit/AuditSink.js";
import { AuditOutboxWorker } from "../src/audit/AuditOutboxWorker.js";
import type { AppConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { AppDatabase, type UserRow, type WalletRow } from "../src/db/client.js";
import type { AppLogger } from "../src/lib/logger.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");

const silentLogger: AppLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger
} as unknown as AppLogger;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "test-token",
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, String(value)]))
  });
}

function fakeAgentCash(overrides: Partial<AgentCashClient> = {}): AgentCashClient {
  return {
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 1 }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, raw: {} }),
    getDepositInfo: vi.fn(),
    ensureWallet: vi.fn(),
    getHomeDir: vi.fn(),
    extractImageUrl: vi.fn(),
    extractJobId: vi.fn(),
    extractJobLink: vi.fn(),
    pollJob: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides
  } as unknown as AgentCashClient;
}

function seedWallet(db: AppDatabase, status: WalletRow["status"] = "active"): { user: UserRow; wallet: WalletRow } {
  const user = db.upsertUser({ telegramUserId: "12345", defaultSpendCapUsdc: 0.5 });
  const wallet = db.createUserWallet(user.id, {
    homeDirHash: "home-hash",
    address: "0xABC",
    encryptedPrivateKey: "encrypted",
    status
  });
  return { user, wallet };
}

describe("production config guard", () => {
  it("requires production deploy hardening knobs", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        MASTER_ENCRYPTION_KEY: MASTER_KEY,
        HARD_SPEND_CAP_USDC: "5"
      })
    ).toThrow(/DATABASE_PROVIDER=postgres/);
  });

  it("accepts a hardened production-shaped config", () => {
    const config = parseConfig({
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "test-token",
      DATABASE_PROVIDER: "postgres",
      DATABASE_URL: "postgres://example.invalid/db",
      LOCK_PROVIDER: "redis",
      REDIS_URL: "redis://localhost:6379",
      CUSTODY_MODE: "remote_signer",
      REMOTE_SIGNER_URL: "https://signer.example",
      AUDIT_SINK: "file",
      AGENTCASH_ARGS: "agentcash@0.14.3",
      HARD_SPEND_CAP_USDC: "5",
      MASTER_ENCRYPTION_KEY: MASTER_KEY
    });

    expect(config.DATABASE_PROVIDER).toBe("postgres");
  });
});

describe("audit redaction", () => {
  it("redacts raw prompts, emails, tokens, and private keys", () => {
    const sanitized = sanitizeAuditEvent({
      eventName: "quote_created",
      metadata: {
        prompt: "write this raw prompt",
        email: "person@example.com",
        privateKey: "0xsecret",
        token: "secret-token",
        cost: 1
      }
    });

    expect(JSON.stringify(sanitized)).not.toContain("person@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("0xsecret");
    expect(sanitized.metadata?.cost).toBe(1);
  });

  it("suspicious replay attempts write audit events", () => {
    const db = new AppDatabase(":memory:");
    db.initialize();

    db.logPreflightAttempt({
      userHash: "actor-hash",
      skill: "research",
      failureStage: "replay",
      errorCode: "REPLAY",
      safeErrorMessage: "Replay attempt"
    });

    const row = db.sqlite.prepare("SELECT * FROM audit_events WHERE event_name = 'suspicious_replay_attempt'").get();
    expect(row).toBeTruthy();
    db.close();
  });
});

describe("audit outbox worker", () => {
  it("ships DB audit events to a file sink and redacts sensitive metadata", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcash-audit-outbox-"));
    const auditPath = path.join(tempDir, "audit-events.jsonl");

    try {
      db.createAuditEvent({
        eventName: "quote.created",
        status: "pending",
        metadata: {
          prompt: "research this private prompt",
          email: "person@example.com",
          privateKey: "0xsecret",
          cost: 7
        }
      });

      const worker = new AuditOutboxWorker(db, new FileAuditSink(auditPath), "file", silentLogger);
      await worker.runOnce();

      const output = fs.readFileSync(auditPath, "utf8");
      expect(output).toContain("quote_created");
      expect(output).toContain("\"cost\":7");
      expect(output).not.toContain("private prompt");
      expect(output).not.toContain("person@example.com");
      expect(output).not.toContain("0xsecret");

      const row = db.sqlite
        .prepare("SELECT shipped_at, ship_attempts, sink_name FROM audit_events WHERE event_name = 'quote_created'")
        .get() as { shipped_at: string | null; ship_attempts: number; sink_name: string | null };
      expect(row.shipped_at).toBeTruthy();
      expect(row.ship_attempts).toBe(0);
      expect(row.sink_name).toBe("file");
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("increments attempt count when an HTTP sink fails", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const server = await startAuditTestServer(500);

    try {
      db.createAuditEvent({ eventName: "quote.created", metadata: { cost: 1 } });
      const worker = new AuditOutboxWorker(
        db,
        new HTTPAuditSink(`http://127.0.0.1:${server.port}/audit`),
        "http",
        silentLogger
      );

      await worker.runOnce();

      const row = db.sqlite
        .prepare(
          "SELECT shipped_at, ship_attempts, last_ship_error, sink_name FROM audit_events WHERE event_name = 'quote_created'"
        )
        .get() as {
        shipped_at: string | null;
        ship_attempts: number;
        last_ship_error: string | null;
        sink_name: string | null;
      };
      expect(row.shipped_at).toBeNull();
      expect(row.ship_attempts).toBe(1);
      expect(row.last_ship_error).toContain("500");
      expect(row.sink_name).toBe("http");
    } finally {
      db.close();
      await closeServer(server.server);
    }
  });

  it("does not double-ship already shipped events", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcash-audit-outbox-"));
    const auditPath = path.join(tempDir, "audit-events.jsonl");

    try {
      db.createAuditEvent({ eventName: "wallet.created", metadata: { cost: 1 } });
      const worker = new AuditOutboxWorker(db, new FileAuditSink(auditPath), "file", silentLogger);

      await worker.runOnce();
      await worker.runOnce();

      const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails strict readiness checks when the configured sink is unhealthy", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const server = await startAuditTestServer(500);

    try {
      const worker = new AuditOutboxWorker(
        db,
        new HTTPAuditSink(`http://127.0.0.1:${server.port}/audit`),
        "http",
        silentLogger
      );

      await expect(worker.checkSinkHealth()).rejects.toThrow(/500/);
    } finally {
      db.close();
      await closeServer(server.server);
    }
  });
});

async function startAuditTestServer(statusCode: number): Promise<{ server: Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }));
  });

  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test audit server did not bind to a TCP port");
  }

  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("incident controls", () => {
  it("frozen wallets cannot create paid quotes", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const { user, wallet } = seedWallet(db, "disabled");
    const ac = fakeAgentCash();
    const wm = {
      getOrCreateWalletForTelegramUser: vi.fn().mockResolvedValue({ user, wallet }),
      getConfirmationCap: vi.fn().mockReturnValue(0.5),
      getSpendCap: vi.fn().mockReturnValue(0.5)
    } as unknown as WalletManager;
    const executor = new SkillExecutor(db, wm, ac, silentLogger, makeConfig());

    await expect(executor.execute("research", "x402", { telegramId: "12345", telegramChatId: "12345" }))
      .rejects.toThrow(/frozen/);
    expect(ac.fetchJson).not.toHaveBeenCalled();
    db.close();
  });

  it("frozen wallets still allow balance checks", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    seedWallet(db, "disabled");
    const ac = fakeAgentCash();
    const wm = new WalletManager(db, makeConfig(), ac);

    await expect(wm.getBalance("12345")).resolves.toMatchObject({ balance: { usdcBalance: 10 } });
    db.close();
  });

  it("rate limits repeated quote attempts", async () => {
    const db = new AppDatabase(":memory:");
    db.initialize();
    const { user, wallet } = seedWallet(db, "active");
    const ac = fakeAgentCash();
    const wm = {
      getOrCreateWalletForTelegramUser: vi.fn().mockResolvedValue({ user, wallet }),
      getConfirmationCap: vi.fn().mockReturnValue(0.5),
      getSpendCap: vi.fn().mockReturnValue(0.5)
    } as unknown as WalletManager;
    const executor = new SkillExecutor(
      db,
      wm,
      ac,
      silentLogger,
      makeConfig({ RATE_LIMIT_QUOTE_MAX_PER_MINUTE: 1 })
    );

    await executor.execute("research", "x402", { telegramId: "12345", telegramChatId: "12345" });
    await expect(executor.execute("research", "x402 again", { telegramId: "12345", telegramChatId: "12345" }))
      .rejects.toThrow(/Rate limit/);
    db.close();
  });
});

describe("runbook links", () => {
  it("README links to every required runbook", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    for (const file of [
      "leaked_bot_token.md",
      "leaked_master_key.md",
      "suspicious_spend.md",
      "failed_agentcash_cli.md",
      "redis_outage.md",
      "postgres_outage.md",
      "revoke_user_or_group.md"
    ]) {
      expect(readme).toContain(`docs/runbooks/${file}`);
    }
  });
});
