import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { AppConfig } from "../src/config.js";
import { buildPreviewArticle, createInlineQueryHandler, parseInlineQuery } from "../src/commands/inlineMode.js";
import { createStartCommand } from "../src/commands/start.js";
import { createSkillCommand } from "../src/commands/skillCommand.js";
import { AppDatabase } from "../src/db/client.js";
import { consumeSignedInlinePayload, createSignedInlinePayload } from "../src/lib/inlinePayload.js";
import type { AppLogger } from "../src/lib/logger.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.alloc(32, 44).toString("base64");

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_BOT_USERNAME: "agentcash_test_bot",
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
    DEFAULT_SPEND_CAP_USDC: 5,
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

function makeAgentCashClient(overrides: Partial<AgentCashClient> = {}): AgentCashClient {
  return {
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 1 }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, raw: {} }),
    ensureWallet: vi.fn().mockResolvedValue({
      address: "0xABC",
      network: "base",
      depositLink: "https://deposit.example",
      encryptedPrivateKey: "v1.iv.tag.ct",
      raw: {}
    }),
    getDepositInfo: vi.fn().mockResolvedValue({
      address: "0xABC",
      network: "base",
      depositLink: "https://deposit.example",
      raw: {}
    }),
    getHomeDir: vi.fn().mockReturnValue("/tmp/test"),
    extractImageUrl: vi.fn().mockReturnValue(undefined),
    extractJobId: vi.fn().mockReturnValue(undefined),
    extractJobLink: vi.fn().mockReturnValue(undefined),
    pollJob: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as AgentCashClient;
}

describe("inline mode", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("returns a safe preview article for inline query text", () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const parsed = parseInlineQuery("research x402 adoption in Asia");

    expect(parsed.type).toBe("intent");
    if (parsed.type !== "intent") throw new Error("expected inline intent");

    const article = buildPreviewArticle({ config, db }, parsed);
    expect(article.title).toBe("Research: x402 adoption in Asia");
    expect(article.description).toBe("Estimate and confirm before spending");
    expect(JSON.stringify(article.input_message_content)).not.toContain("x402 adoption in Asia");
    expect(JSON.stringify(article.reply_markup)).toContain("https://t.me/agentcash_test_bot?start=il_");
  });

  it("inline query handler does not execute a paid call", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const handler = createInlineQueryHandler({ config: makeConfig(), db, logger: silentLogger });
    const answerInlineQuery = vi.fn();

    await handler({
      inlineQuery: { query: "generate neon wallet icon" },
      answerInlineQuery
    } as never);

    expect(answerInlineQuery).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT * FROM quotes").all()).toHaveLength(0);
    expect(db.sqlite.prepare("SELECT * FROM transactions").all()).toHaveLength(0);
  });

  it("treats non-email enrich inline queries as help, not a paid preview", () => {
    const parsed = parseInlineQuery("enrich example.com");

    expect(parsed).toEqual({ type: "help", reason: "ambiguous" });
  });

  it("rejects expired inline payloads", () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const { token } = createSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, {
      skill: "research",
      sanitizedInput: "x402 adoption"
    });
    db.sqlite
      .prepare("UPDATE inline_payloads SET expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());

    expect(() => consumeSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, token)).toThrow(
      "expired"
    );
  });

  it("rejects tampered inline payloads", () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const { token } = createSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, {
      skill: "generate",
      sanitizedInput: "neon wallet icon"
    });
    const replacement = token.endsWith("0") ? "1" : "0";
    const tampered = `${token.slice(0, -1)}${replacement}`;

    expect(() => consumeSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, tampered)).toThrow();
  });

  it("valid inline start payload enters confirmation flow", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, config, ac);
    const executor = new SkillExecutor(db, wm, ac, silentLogger, config);
    const { token } = createSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, {
      skill: "research",
      sanitizedInput: "x402 adoption"
    });
    const replies: string[] = [];
    const handler = createStartCommand({ config, db, walletManager: wm, skillExecutor: executor });

    await handler({
      from: { id: 12345 },
      chat: { id: 12345, type: "private" },
      message: { text: `/start ${token}`, message_id: 1 },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
      })
    } as never);

    expect(replies[0]).toContain("quoted at");
    expect(db.sqlite.prepare("SELECT * FROM quotes").all()).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM transactions").all()).toHaveLength(0);
    expect(ac.fetchJson).not.toHaveBeenCalled();
  });

  it("existing slash command behavior remains unchanged", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, config, ac);
    const executor = new SkillExecutor(db, wm, ac, silentLogger, config);
    const replies: string[] = [];
    const handler = createSkillCommand({
      config,
      db,
      walletManager: wm,
      skillExecutor: executor,
      skillName: "research"
    });

    await handler({
      from: { id: 12345 },
      chat: { id: 12345, type: "private" },
      message: { text: "/research x402 adoption", message_id: 1 },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
      })
    } as never);

    expect(replies[0]).toContain("Research completed");
    expect(ac.fetchJson).toHaveBeenCalledTimes(1);
  });
});
