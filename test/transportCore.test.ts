import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { AppConfig } from "../src/config.js";
import { runBalanceCommand, runSkillCommand } from "../src/core/commandHandlers.js";
import type { CommandContext } from "../src/core/commandContext.js";
import { AppDatabase } from "../src/db/client.js";
import { QuoteError } from "../src/lib/errors.js";
import type { AppLogger } from "../src/lib/logger.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.alloc(32, 45).toString("base64");

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_BOT_USERNAME: "agentcash_test_bot",
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_APPLICATION_ID: "discord-app",
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

function makeAgentCashClient(overrides: Partial<AgentCashClient> = {}): AgentCashClient {
  return {
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 100 }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, address: "0xABC", raw: {} }),
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

function makeContext(
  platform: "telegram" | "discord",
  overrides: Partial<CommandContext> = {}
): CommandContext & { replies: string[]; confirmations: string[] } {
  const replies: string[] = [];
  const confirmations: string[] = [];
  const walletOwnerId = platform === "telegram" ? "12345" : "discord:99999";
  const chatId = platform === "telegram" ? "12345" : "discord:dm:99999";

  return {
    platform,
    actorIdHash: `${platform}-actor-hash`,
    chatIdHash: `${platform}-chat-hash`,
    walletScope: {
      kind: "user",
      walletOwnerId,
      chatId,
      chatType: "private"
    },
    reply: async message => {
      replies.push(message);
    },
    replyPrivateOrEphemeral: async message => {
      replies.push(message);
    },
    confirm: async input => {
      confirmations.push(input.quoteId);
      replies.push(input.text);
    },
    replies,
    confirmations,
    ...overrides
  };
}

describe("transport-neutral command layer", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("shared balance command can be called by Telegram and Discord contexts", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const deps = { config, db, walletManager, skillExecutor };

    const telegramCtx = makeContext("telegram");
    const discordCtx = makeContext("discord");

    await runBalanceCommand(telegramCtx, deps);
    await runBalanceCommand(discordCtx, deps);

    expect(telegramCtx.replies[0]).toContain("Wallet address");
    expect(discordCtx.replies[0]).toContain("Wallet address");
    expect(db.sqlite.prepare("SELECT * FROM wallets WHERE kind = 'user'").all()).toHaveLength(2);
  });

  it("Discord research enters quote and confirmation path without executing immediately", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const discordCtx = makeContext("discord");

    await runSkillCommand(
      discordCtx,
      { config, db, walletManager, skillExecutor },
      "research",
      "x402 adoption"
    );

    expect(discordCtx.confirmations).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM quotes").all()).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM transactions").all()).toHaveLength(0);
    expect(ac.fetchJson).not.toHaveBeenCalled();
  });

  it("Discord confirmation cannot be replayed", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const discordCtx = makeContext("discord");

    await runSkillCommand(
      discordCtx,
      { config, db, walletManager, skillExecutor },
      "research",
      "x402 adoption"
    );

    const quoteId = discordCtx.confirmations[0]!;
    await skillExecutor.executeApprovedQuote(quoteId, {
      telegramId: "discord:99999",
      telegramChatId: "discord:dm:99999",
      telegramChatType: "private"
    });

    await expect(
      skillExecutor.executeApprovedQuote(quoteId, {
        telegramId: "discord:99999",
        telegramChatId: "discord:dm:99999",
        telegramChatType: "private"
      })
    ).rejects.toThrow(QuoteError);

    expect(ac.fetchJson).toHaveBeenCalledTimes(1);
  });
});
