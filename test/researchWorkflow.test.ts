import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenerateCommand } from "../src/commands/generate.js";
import { createEnrichCommand } from "../src/commands/enrich.js";
import { createResearchCommand } from "../src/commands/research.js";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";
import type { AppLogger } from "../src/lib/logger.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import { ResearchWorkflowService } from "../src/research/ResearchWorkflowService.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.alloc(32, 47).toString("base64");

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
    DEFAULT_SPEND_CAP_USDC: 0.5,
    HARD_SPEND_CAP_USDC: 5,
    ALLOW_HIGH_VALUE_CALLS: false,
    ALLOW_UNQUOTED_DEV_CALLS: false,
    RESEARCH_WORKFLOW_DEMO_MODE: true,
    PENDING_CONFIRMATION_TTL_SECONDS: 300,
    RATE_LIMIT_MAX_PER_MINUTE: 100,
    RATE_LIMIT_MAX_PER_HOUR: 1000,
    RATE_LIMIT_QUOTE_MAX_PER_MINUTE: 100,
    RATE_LIMIT_PAID_EXECUTION_MAX_PER_MINUTE: 100,
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
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 8, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 8 }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 1, address: "0xABC", raw: {} }),
    ensureWallet: vi.fn().mockResolvedValue({
      address: "0xABC",
      network: "base",
      depositLink: "https://deposit.example",
      encryptedPrivateKey: "v1.iv.tag.ct",
      raw: {}
    }),
    getDepositInfo: vi.fn(),
    getHomeDir: vi.fn().mockReturnValue("/tmp/test"),
    extractImageUrl: vi.fn().mockReturnValue(undefined),
    extractJobId: vi.fn().mockReturnValue(undefined),
    extractJobLink: vi.fn().mockReturnValue(undefined),
    pollJob: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as AgentCashClient;
}

function makeTelegramContext(text: string, replies: string[] = []) {
  return {
    from: { id: 12345 },
    chat: { id: 12345, type: "private" },
    message: { text, message_id: 1 },
    reply: vi.fn(async (message: string) => {
      replies.push(message);
    })
  };
}

function makeDeps(configOverrides: Partial<AppConfig> = {}, agentcashOverrides: Partial<AgentCashClient> = {}) {
  const db = new AppDatabase(":memory:");
  db.initialize();
  const config = makeConfig(configOverrides);
  const ac = makeAgentCashClient(agentcashOverrides);
  const walletManager = new WalletManager(db, config, ac);
  const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
  const researchWorkflowService = new ResearchWorkflowService(db, walletManager, ac, silentLogger, config);
  return { db, config, ac, walletManager, skillExecutor, researchWorkflowService };
}

describe("agentic research workflow", () => {
  let db: AppDatabase | undefined;

  afterEach(() => db?.close());

  it("/research creates a multi-step plan and stores an aggregate quote", async () => {
    const deps = makeDeps();
    db = deps.db;
    const replies: string[] = [];

    await createResearchCommand(deps)(
      makeTelegramContext("/research Generate a deep research report on agentic payments", replies) as never
    );

    expect(replies[0]).toContain("I'll compile a comprehensive report using multiple data sources.");
    expect(replies[0]).toContain("Exa Search");
    expect(replies[0]).toContain("Firecrawl");
    expect(replies[0]).toContain("Total estimated AgentCash spend: $0.34.");

    const quotes = db.sqlite.prepare("SELECT * FROM quotes").all() as Array<{ quoted_cost_cents: number; endpoint: string }>;
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.quoted_cost_cents).toBe(34);
    expect(quotes[0]!.endpoint).toBe("agentic-research://workflow/v1");
  });

  it("/research does not immediately execute paid tools", async () => {
    const deps = makeDeps();
    db = deps.db;

    await createResearchCommand(deps)(
      makeTelegramContext("/research Generate a deep research report on agentic payments") as never
    );

    expect(deps.ac.fetchJson).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT * FROM transactions").all()).toHaveLength(0);
  });

  it("/research aggregates paid tool quotes into the total", async () => {
    const deps = makeDeps();
    db = deps.db;

    const result = await deps.researchWorkflowService.planAndQuote(
      "Generate a deep research report on agentic payments",
      { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
    );

    expect(result.quotedCostCents).toBe(34);
    expect(result.text).toContain("estimated $0.08");
    expect(result.text).toContain("estimated $0.18");
  });

  it("$0.34 total with $0.50 cap and $1 balance enters confirmation", async () => {
    const deps = makeDeps({ DEFAULT_SPEND_CAP_USDC: 0.5 }, {
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 1, raw: {} })
    });
    db = deps.db;

    const result = await deps.researchWorkflowService.planAndQuote(
      "Generate a deep research report on agentic payments",
      { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
    );

    expect(result.type).toBe("confirmation_required");
    expect(result.quotedCostCents).toBe(34);
  });

  it("$0.34 total with $0.25 cap returns exceeds_user_cap", async () => {
    const deps = makeDeps({ DEFAULT_SPEND_CAP_USDC: 0.25 }, {
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 1, raw: {} })
    });
    db = deps.db;

    await expect(
      deps.researchWorkflowService.planAndQuote(
        "Generate a deep research report on agentic payments",
        { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
      )
    ).rejects.toThrow(/exceeds_user_cap/);
  });

  it("$1.25 total with $1 balance returns insufficient_balance", async () => {
    const deps = makeDeps({ DEFAULT_SPEND_CAP_USDC: 5, RESEARCH_WORKFLOW_DEMO_MODE: false }, {
      checkEndpoint: vi.fn()
        .mockResolvedValueOnce({ estimatedCostCents: 50, raw: {} })
        .mockResolvedValueOnce({ estimatedCostCents: 50, raw: {} })
        .mockResolvedValueOnce({ estimatedCostCents: 25, raw: {} }),
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 1, raw: {} })
    });
    db = deps.db;

    await expect(
      deps.researchWorkflowService.planAndQuote(
        "Generate a deep research report on agentic payments",
        { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
      )
    ).rejects.toThrow(/insufficient_balance/);
  });

  it("$6 total with $5 hard cap returns exceeds_hard_cap", async () => {
    const deps = makeDeps({ DEFAULT_SPEND_CAP_USDC: 10, HARD_SPEND_CAP_USDC: 5, RESEARCH_WORKFLOW_DEMO_MODE: false }, {
      checkEndpoint: vi.fn()
        .mockResolvedValueOnce({ estimatedCostCents: 200, raw: {} })
        .mockResolvedValueOnce({ estimatedCostCents: 200, raw: {} })
        .mockResolvedValueOnce({ estimatedCostCents: 200, raw: {} }),
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, raw: {} })
    });
    db = deps.db;

    await expect(
      deps.researchWorkflowService.planAndQuote(
        "Generate a deep research report on agentic payments",
        { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
      )
    ).rejects.toThrow(/exceeds_hard_cap/);
  });

  it("missing quote returns quote_missing", async () => {
    const deps = makeDeps({ RESEARCH_WORKFLOW_DEMO_MODE: false }, {
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: undefined, raw: {} }),
      getBalance: vi.fn().mockResolvedValue({ usdcBalance: 1, raw: {} })
    });
    db = deps.db;

    await expect(
      deps.researchWorkflowService.planAndQuote(
        "Generate a deep research report on agentic payments",
        { telegramId: "12345", telegramChatId: "12345", telegramChatType: "private" }
      )
    ).rejects.toThrow(/quote_missing/);
  });

  it("existing /enrich and /generate commands still use SkillExecutor directly", async () => {
    const deps = makeDeps();
    db = deps.db;
    const execute = vi.fn().mockResolvedValue({ type: "completed", text: "ok" });
    const directDeps = {
      ...deps,
      skillExecutor: { execute } as unknown as SkillExecutor
    };

    await createEnrichCommand(directDeps)(
      makeTelegramContext("/enrich person@example.com") as never
    );
    await createGenerateCommand(directDeps)(
      makeTelegramContext("/generate neon wallet icon") as never
    );

    expect(execute).toHaveBeenNthCalledWith(
      1,
      "enrich",
      "person@example.com",
      expect.objectContaining({ telegramId: "12345" })
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "generate",
      "neon wallet icon",
      expect.objectContaining({ telegramId: "12345" })
    );
  });
});
