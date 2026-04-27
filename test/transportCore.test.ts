import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { AppConfig } from "../src/config.js";
import { runBalanceCommand, runSkillCommand } from "../src/core/commandHandlers.js";
import type { CommandContext } from "../src/core/commandContext.js";
import { AppDatabase } from "../src/db/client.js";
import { buildDiscordCommandPayload, handleSlashCommand } from "../src/discordBot.js";
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
    const ac = makeAgentCashClient({
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 25, raw: {} })
    });
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const discordCtx = makeContext("discord");

    await runSkillCommand(
      discordCtx,
      { config, db, walletManager, skillExecutor },
      "research",
      "x402 adoption",
      { forceConfirmation: true }
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
    const ac = makeAgentCashClient({
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 25, raw: {} })
    });
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const discordCtx = makeContext("discord");

    await runSkillCommand(
      discordCtx,
      { config, db, walletManager, skillExecutor },
      "research",
      "x402 adoption",
      { forceConfirmation: true }
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

  it("Discord command registration includes wallet and guild subcommands", () => {
    const payload = buildDiscordCommandPayload() as Array<{ options: Array<{ name: string; options: Array<{ name: string }> }> }>;
    const ac = payload[0]!;
    const groups = new Map(ac.options.map(group => [group.name, group.options.map(option => option.name)]));

    expect(groups.get("wallet")).toEqual(expect.arrayContaining(["balance", "deposit", "cap", "history", "research"]));
    expect(groups.get("guild")).toEqual(expect.arrayContaining(["create", "balance", "deposit", "cap", "history", "sync-admins", "research"]));
  });

  it("Discord guild default paid call does not silently use a user wallet", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const interaction = makeDiscordInteraction({
      group: null,
      subcommand: "research",
      query: "x402 adoption",
      guildId: "guild-1"
    });

    await handleSlashCommand(interaction as never, { config, db, walletManager, skillExecutor, logger: silentLogger });

    expect(interaction.replies[0]?.content).toContain("Use /ac wallet research");
    expect(db.sqlite.prepare("SELECT * FROM wallets").all()).toHaveLength(0);
  });

  it("Discord guild create requires Manage Server or Administrator", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const interaction = makeDiscordInteraction({
      group: "guild",
      subcommand: "create",
      guildId: "guild-1",
      permissions: "0"
    });

    await expect(
      handleSlashCommand(interaction as never, { config, db, walletManager, skillExecutor, logger: silentLogger })
    ).rejects.toThrow(/Manage Server/);
  });

  it("Discord guild cap requires Manage Server or Administrator", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    await walletManager.getOrCreateDiscordGuildWallet({ guildId: "guild-1", createdByDiscordId: "99999" });
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const interaction = makeDiscordInteraction({
      group: "guild",
      subcommand: "cap",
      guildId: "guild-1",
      amount: "1",
      permissions: "0"
    });

    await expect(
      handleSlashCommand(interaction as never, { config, db, walletManager, skillExecutor, logger: silentLogger })
    ).rejects.toThrow(/Manage Server/);
  });

  it("Discord guild wallet paid call uses the guild wallet", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig({ DEFAULT_SPEND_CAP_USDC: 5 });
    const ac = makeAgentCashClient({ checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }) });
    const walletManager = new WalletManager(db, config, ac);
    const groupContext = await walletManager.getOrCreateDiscordGuildWallet({
      guildId: "guild-1",
      createdByDiscordId: "99999"
    });
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const guildCtx = makeContext("discord", {
      walletScope: {
        kind: "guild",
        walletOwnerId: "discord:99999",
        chatId: "guild-1",
        chatType: "discord_guild",
        guildId: "guild-1",
        channelId: "channel-1"
      }
    });

    const result = await runSkillCommand(guildCtx, { config, db, walletManager, skillExecutor }, "research", "x402 adoption");
    void result;

    const transaction = db.sqlite.prepare("SELECT * FROM transactions").get() as { wallet_id: string; group_id: string };
    expect(transaction.wallet_id).toBe(groupContext.wallet.id);
    expect(transaction.group_id).toBe(groupContext.group!.id);
  });

  it("wrong Discord user cannot confirm a user-wallet quote", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient({
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 25, raw: {} })
    });
    const walletManager = new WalletManager(db, config, ac);
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const discordCtx = makeContext("discord");

    await runSkillCommand(
      discordCtx,
      { config, db, walletManager, skillExecutor },
      "research",
      "x402 adoption",
      { forceConfirmation: true }
    );

    await expect(
      skillExecutor.executeApprovedQuote(discordCtx.confirmations[0]!, {
        telegramId: "discord:11111",
        telegramChatId: "discord:dm:99999",
        telegramChatType: "private"
      })
    ).rejects.toThrow(QuoteError);
  });

  it("Discord guild admin can approve a guild quote when policy requires admin", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const walletManager = new WalletManager(db, config, ac);
    const groupContext = await walletManager.getOrCreateDiscordGuildWallet({
      guildId: "guild-1",
      createdByDiscordId: "99999"
    });
    const skillExecutor = new SkillExecutor(db, walletManager, ac, silentLogger, config);
    const guildCtx = makeContext("discord", {
      walletScope: {
        kind: "guild",
        walletOwnerId: "discord:11111",
        chatId: "guild-1",
        chatType: "discord_guild",
        guildId: "guild-1",
        channelId: "channel-1"
      }
    });

    await runSkillCommand(guildCtx, { config, db, walletManager, skillExecutor }, "research", "x402 adoption");
    const admin = db.getUserByTelegramId("discord:99999")!;
    db.recordTelegramAdminVerification({
      groupId: groupContext.group!.id,
      userId: admin.id,
      telegramStatus: "administrator",
      source: "discord_permissions"
    });

    await expect(
      skillExecutor.executeApprovedQuote(guildCtx.confirmations[0]!, {
        telegramId: "discord:99999",
        telegramChatId: "guild-1",
        telegramChatType: "discord_guild"
      })
    ).resolves.toMatchObject({ type: "completed" });
  });
});

function makeDiscordInteraction(input: {
  group: string | null;
  subcommand: string;
  query?: string;
  amount?: string;
  guildId?: string | null;
  permissions?: string;
}) {
  const replies: Array<{ content: string; ephemeral?: boolean }> = [];
  return {
    id: "interaction-1",
    commandName: "ac",
    user: { id: "99999" },
    guildId: input.guildId ?? null,
    channelId: "channel-1",
    member: input.guildId
      ? { permissions: input.permissions ?? String(1n << 5n) }
      : null,
    replies,
    options: {
      getSubcommandGroup: () => input.group,
      getSubcommand: () => input.subcommand,
      getString: (name: string) => (name === "query" ? input.query : input.amount) ?? null,
      getBoolean: () => false
    },
    isRepliable: () => true,
    replied: false,
    deferred: false,
    reply: vi.fn(async (message: { content: string; ephemeral?: boolean } | string) => {
      replies.push(typeof message === "string" ? { content: message } : message);
    }),
    followUp: vi.fn(async (message: { content: string; ephemeral?: boolean } | string) => {
      replies.push(typeof message === "string" ? { content: message } : message);
    })
  };
}
