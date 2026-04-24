import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/db/client.js";
import { SkillExecutor, canonicalizeJson } from "../src/agentcash/skillExecutor.js";
import type { AppConfig } from "../src/config.js";
import type { AppLogger } from "../src/lib/logger.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { WalletManager } from "../src/wallets/walletManager.js";
import type { UserRow, WalletRow } from "../src/db/client.js";
import { QuoteError, SpendingCapError, InsufficientBalanceError } from "../src/lib/errors.js";

const MASTER_KEY = Buffer.alloc(32, 42).toString("base64");

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent" as const,
    BOT_MODE: "polling" as const,
    WEBHOOK_PATH: "/tg",
    WEBHOOK_HOST: "0.0.0.0",
    WEBHOOK_PORT: 3000,
    AGENTCASH_COMMAND: "agentcash",
    AGENTCASH_ARGS: "agentcash@latest",
    agentcashArgs: ["agentcash@latest"],
    AGENTCASH_TIMEOUT_MS: 5000,
    DEFAULT_SPEND_CAP_USDC: 0.5,
    HARD_SPEND_CAP_USDC: 5,
    ALLOW_HIGH_VALUE_CALLS: false,
    ALLOW_UNQUOTED_DEV_CALLS: false,
    PENDING_CONFIRMATION_TTL_SECONDS: 300,
    RATE_LIMIT_MAX_PER_MINUTE: 100,
    RATE_LIMIT_MAX_PER_HOUR: 1000,
    AGENTCASH_HOME_ROOT: "/tmp/agentcash-test",
    ROUTER_CONFIDENCE_THRESHOLD: 0.75,
    ROUTER_TIMEOUT_MS: 5000,
    OPENAI_ROUTER_MODEL: "gpt-4o-mini",
    ANTHROPIC_ROUTER_MODEL: "claude-haiku-4-5-20251001",
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
    ...overrides
  } as AppConfig;
}

const silentLogger: AppLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger
} as unknown as AppLogger;

function makeWalletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: "wal_test",
    kind: "user",
    owner_user_id: "usr_test",
    owner_group_id: null,
    home_dir_hash: "testhash",
    address: "0xABCDEF1234567890",
    network: "base",
    deposit_link: null,
    encrypted_private_key: "v1.iv.tag.ct",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "usr_test",
    telegram_user_id: "12345",
    username: null,
    first_name: null,
    last_name: null,
    cap_enabled: 1,
    default_spend_cap_usdc: 0.5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function makeAgentCashClient(overrides: Partial<AgentCashClient> = {}): AgentCashClient {
  return {
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 1, txHash: "0xtx" }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, raw: {} }),
    ensureWallet: vi.fn().mockResolvedValue({ address: "0xABC", encryptedPrivateKey: "v1.iv.tag.ct", raw: {} }),
    getDepositInfo: vi.fn().mockResolvedValue({ address: "0xABC", raw: {} }),
    getHomeDir: vi.fn().mockReturnValue("/tmp/test"),
    extractImageUrl: vi.fn().mockReturnValue(undefined),
    extractJobId: vi.fn().mockReturnValue(undefined),
    extractJobLink: vi.fn().mockReturnValue(undefined),
    pollJob: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as AgentCashClient;
}

function makeWalletManager(userRow: UserRow, walletRow: WalletRow, overrides: Partial<WalletManager> = {}): WalletManager {
  return {
    getOrCreateWalletForTelegramUser: vi.fn().mockResolvedValue({ user: userRow, wallet: walletRow }),
    getExistingUser: vi.fn().mockReturnValue(userRow),
    getConfirmationCap: vi.fn().mockReturnValue(0.5),
    getSpendCap: vi.fn().mockReturnValue(0.5),
    updateUserCap: vi.fn(),
    getBalance: vi.fn(),
    getDepositAddress: vi.fn(),
    getDepositQrDataUrl: vi.fn(),
    ...overrides
  } as unknown as WalletManager;
}

function makeExecutor(db: AppDatabase, config: AppConfig, agentcash?: Partial<AgentCashClient>, walletMgr?: Partial<WalletManager>) {
  const user = makeUserRow();
  const wallet = makeWalletRow();
  const ac = makeAgentCashClient(agentcash);
  const wm = makeWalletManager(user, wallet, walletMgr);
  return new SkillExecutor(db, wm, ac, silentLogger, config);
}

const baseContext = {
  telegramId: "12345",
  telegramChatId: "12345"
};

describe("Phase 1 - Quote failure does not execute", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("does not execute when checkEndpoint fails (safe fail)", async () => {
    const executor = makeExecutor(db, makeConfig({ ALLOW_UNQUOTED_DEV_CALLS: false }), {
      checkEndpoint: vi.fn().mockRejectedValue(new Error("CLI error"))
    });

    await expect(
      executor.execute("research", "x402 protocol", baseContext)
    ).rejects.toThrow(QuoteError);

    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts").all() as Array<{ failure_stage: string }>;
    expect(preflights).toHaveLength(1);
    expect(preflights[0]!.failure_stage).toBe("quote");
    const transactions = db.sqlite.prepare("SELECT * FROM transactions").all();
    expect(transactions).toHaveLength(0);
  });

  it("does not execute when price is missing from check response", async () => {
    const executor = makeExecutor(db, makeConfig({ ALLOW_UNQUOTED_DEV_CALLS: false }), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: undefined, raw: {} })
    });

    await expect(
      executor.execute("research", "x402 protocol", baseContext)
    ).rejects.toThrow(QuoteError);

    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts").all() as Array<{ failure_stage: string }>;
    expect(preflights[0]!.failure_stage).toBe("quote");
  });
});

describe("Phase 1 - ALLOW_UNQUOTED_DEV_CALLS", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("proceeds with dev_unquoted=true when ALLOW_UNQUOTED_DEV_CALLS=true and check fails", async () => {
    const executor = makeExecutor(db, makeConfig({ ALLOW_UNQUOTED_DEV_CALLS: true, DEFAULT_SPEND_CAP_USDC: 5 }), {
      checkEndpoint: vi.fn().mockRejectedValue(new Error("CLI error")),
      fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 0 })
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    expect(result.type).toBe("completed");

    const quotes = db.sqlite.prepare("SELECT * FROM quotes").all() as Array<{ is_dev_unquoted: number }>;
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.is_dev_unquoted).toBe(1);
  });
});

describe("Phase 2 - Immutable quote records", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("creates a quote record before showing confirmation", async () => {
    const executor = makeExecutor(db, makeConfig(), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} })
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    expect(result.type).toBe("confirmation_required");

    if (result.type !== "confirmation_required") throw new Error("unreachable");
    expect(result.quoteId).toMatch(/^quo_/);

    const quote = db.getQuote(result.quoteId)!;
    expect(quote).toBeTruthy();
    expect(quote.status).toBe("pending");
    expect(quote.quoted_cost_cents).toBe(100);
    expect(quote.canonical_request_json).toContain("x402 protocol");
    expect(quote.request_hash).toBeTruthy();
  });

  it("auto-approves and executes quote that is below cap", async () => {
    const executor = makeExecutor(db, makeConfig({ DEFAULT_SPEND_CAP_USDC: 5 }), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }),
      fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 1 })
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    expect(result.type).toBe("completed");

    const quotes = db.sqlite.prepare("SELECT * FROM quotes").all() as Array<{ status: string }>;
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.status).toBe("executed");
  });
});

describe("Phase 3 - Confirm replay protection", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("confirm executes exactly once", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ raw: {}, data: {}, actualCostCents: 1 });
    const executor = makeExecutor(db, makeConfig(), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} }),
      fetchJson
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    const confirmed = await executor.executeApprovedQuote(result.quoteId, baseContext);
    expect(confirmed.type).toBe("completed");
    expect(fetchJson).toHaveBeenCalledTimes(1);

    const quote = db.getQuote(result.quoteId)!;
    expect(quote.status).toBe("executed");
  });

  it("confirm replay does not execute twice", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ raw: {}, data: {}, actualCostCents: 1 });
    const executor = makeExecutor(db, makeConfig(), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} }),
      fetchJson
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    await executor.executeApprovedQuote(result.quoteId, baseContext);
    await expect(executor.executeApprovedQuote(result.quoteId, baseContext)).rejects.toThrow(QuoteError);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts WHERE failure_stage = 'replay'").all();
    expect(preflights).toHaveLength(1);
  });

  it("expired quote does not execute", async () => {
    const executor = makeExecutor(db, makeConfig({ PENDING_CONFIRMATION_TTL_SECONDS: 300 }), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} })
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    db.sqlite
      .prepare("UPDATE quotes SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), result.quoteId);

    await expect(executor.executeApprovedQuote(result.quoteId, baseContext)).rejects.toThrow(QuoteError);

    const quote = db.getQuote(result.quoteId)!;
    expect(quote.status).toBe("expired");
    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts WHERE failure_stage = 'expired'").all();
    expect(preflights).toHaveLength(1);
  });
});

describe("Phase 5 - Concurrent confirm clicks only execute once", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("concurrent confirm clicks only execute once", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ raw: {}, data: {}, actualCostCents: 1 });
    const executor = makeExecutor(db, makeConfig(), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} }),
      fetchJson
    });

    const result = await executor.execute("research", "x402 protocol", baseContext);
    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    const [r1, r2] = await Promise.allSettled([
      executor.executeApprovedQuote(result.quoteId, baseContext),
      executor.executeApprovedQuote(result.quoteId, baseContext)
    ]);

    const fulfilled = [r1, r2].filter(r => r.status === "fulfilled");
    const rejected = [r1, r2].filter(r => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 5 - Concurrent /start creates one wallet", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("concurrent provisioning calls result in one wallet record", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    let callCount = 0;
    const ac = makeAgentCashClient({
      ensureWallet: vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 10));
        return { address: "0xABC", encryptedPrivateKey: "v1.iv.tag.ct", raw: {} };
      })
    });

    const config = makeConfig();
    const { WalletManager: WM } = await import("../src/wallets/walletManager.js");
    const wm = new WM(db, config, ac);

    const [r1, r2] = await Promise.allSettled([
      wm.getOrCreateWalletForTelegramUser("12345"),
      wm.getOrCreateWalletForTelegramUser("12345")
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    const wallets = db.sqlite.prepare("SELECT * FROM wallets WHERE owner_user_id IS NOT NULL").all();
    expect(wallets).toHaveLength(1);
    expect(callCount).toBe(1);
  });
});

describe("Phase 4 - Cap exceeded logging", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("hard cap exceeded logs preflight failure and does not execute", async () => {
    const executor = makeExecutor(db, makeConfig({ HARD_SPEND_CAP_USDC: 0.01 }), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 500, raw: {} })
    });

    await expect(
      executor.execute("research", "x402 protocol", baseContext)
    ).rejects.toThrow(SpendingCapError);

    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts WHERE failure_stage = 'cap'").all();
    expect(preflights).toHaveLength(1);
    const transactions = db.sqlite.prepare("SELECT * FROM transactions").all();
    expect(transactions).toHaveLength(0);
  });

  it("insufficient balance logs preflight failure", async () => {
    const executor = makeExecutor(db, makeConfig(), {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 200, raw: {} }),
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 0.001, raw: {} })
    });

    await expect(
      executor.execute("research", "x402 protocol", baseContext)
    ).rejects.toThrow(InsufficientBalanceError);

    const preflights = db.sqlite.prepare("SELECT * FROM preflight_attempts WHERE failure_stage = 'balance'").all();
    expect(preflights).toHaveLength(1);
  });
});

describe("Phase 8 - Router malformed output does not execute", () => {
  it("rejects malformed router JSON", async () => {
    const { parseRouterDecision } = await import("../src/router/routerClient.js");

    expect(() => parseRouterDecision("not json at all")).toThrow();
    expect(() => parseRouterDecision('{"skill":"hack","confidence":1}')).toThrow();
    expect(() => parseRouterDecision('{"skill":"research","confidence":2}')).toThrow();
  });

  it("returns null args for missing required fields", async () => {
    const { extractSkillInput, parseRouterDecision } = await import("../src/router/routerClient.js");

    const decision = parseRouterDecision('{"skill":"research","args":{},"confidence":0.9}');
    expect(extractSkillInput(decision)).toBeNull();
  });

  it("low confidence does not route", async () => {
    const { parseRouterDecision } = await import("../src/router/routerClient.js");

    const decision = parseRouterDecision('{"skill":"research","args":{"query":"test"},"confidence":0.3}');
    expect(decision.confidence).toBeLessThan(0.75);
  });
});

describe("Phase 9 - /history returns sanitized data", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
    db.sqlite.exec("INSERT INTO users (id, telegram_user_id, cap_enabled, default_spend_cap_usdc, created_at, updated_at) VALUES ('usr_test', '12345', 1, 0.5, datetime('now'), datetime('now'))");
    db.sqlite.exec("INSERT INTO wallets (id, kind, owner_user_id, home_dir_hash, address, network, encrypted_private_key, status, created_at, updated_at) VALUES ('wal_test', 'user', 'usr_test', 'testhash', '0xABC', 'base', 'v1.iv.tag.ct', 'active', datetime('now'), datetime('now'))");
  });

  afterEach(() => db.close());

  it("returns sanitized history entries scoped by user_hash", async () => {
    const { hashTelegramId } = await import("../src/lib/crypto.js");
    const userHash = hashTelegramId("12345", MASTER_KEY);

    db.createTransaction({
      userId: "usr_test",
      walletId: "wal_test",
      telegramChatId: userHash,
      telegramIdHash: userHash,
      commandName: "research",
      skill: "research",
      status: "success",
      quotedPriceUsdc: 0.01,
      actualCostCents: 1
    });

    const entries = db.getHistoryForUser(userHash);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.skill).toBe("research");
    expect(entries[0]!.status).toBe("success");

    const entryJson = JSON.stringify(entries[0]);
    expect(entryJson).not.toContain("12345");
    expect(entryJson).not.toContain("username");
    expect(entryJson).not.toContain("first_name");
  });

  it("different users cannot see each other's history", async () => {
    const { hashTelegramId } = await import("../src/lib/crypto.js");
    const userHash1 = hashTelegramId("12345", MASTER_KEY);
    const userHash2 = hashTelegramId("99999", MASTER_KEY);

    db.createTransaction({
      userId: "usr_test",
      walletId: "wal_test",
      telegramChatId: userHash1,
      telegramIdHash: userHash1,
      commandName: "research",
      skill: "research",
      status: "success"
    });

    const entries = db.getHistoryForUser(userHash2);
    expect(entries).toHaveLength(0);
  });
});

describe("canonicalizeJson stability", () => {
  it("produces same hash regardless of key insertion order", () => {
    const a = canonicalizeJson({ z: 1, a: 2, m: 3 });
    const b = canonicalizeJson({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects deterministically", () => {
    const a = canonicalizeJson({ b: { z: 1, a: 2 }, a: [3, 1, 2] });
    const b = canonicalizeJson({ a: [3, 1, 2], b: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});
