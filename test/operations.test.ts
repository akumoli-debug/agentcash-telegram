import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import { sanitizeAuditEvent } from "../src/audit/AuditSink.js";
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
