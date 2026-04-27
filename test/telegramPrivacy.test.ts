import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import { createNaturalLanguageTextHandler } from "../src/bot.js";
import type { AppConfig } from "../src/config.js";
import { createBalanceCommand } from "../src/commands/balance.js";
import { createDepositCommand } from "../src/commands/deposit.js";
import { createGroupWalletCommand } from "../src/commands/groupWallet.js";
import { USER_WALLET_DM_INSTRUCTION } from "../src/commands/helpers.js";
import { createHistoryCommand } from "../src/commands/history.js";
import { createResearchCommand } from "../src/commands/research.js";
import { createStartCommand } from "../src/commands/start.js";
import { AppDatabase } from "../src/db/client.js";
import { createSignedInlinePayload } from "../src/lib/inlinePayload.js";
import { QuoteError } from "../src/lib/errors.js";
import type { AppLogger } from "../src/lib/logger.js";
import type { RouterClient } from "../src/router/routerClient.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.alloc(32, 45).toString("base64");

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
    getBalance: vi.fn().mockResolvedValue({
      usdcBalance: 10,
      address: "0xPRIVATE",
      depositLink: "https://deposit.example",
      raw: {}
    }),
    ensureWallet: vi.fn().mockResolvedValue({
      address: "0xPRIVATE",
      network: "base",
      depositLink: "https://deposit.example",
      encryptedPrivateKey: "v1.iv.tag.ct",
      raw: {}
    }),
    getDepositInfo: vi.fn().mockResolvedValue({
      address: "0xPRIVATE",
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

function makeTelegramContext(input: {
  text: string;
  chatType: "private" | "group" | "supergroup";
  chatId?: number;
  fromId?: number;
  replies?: string[];
}) {
  const replies = input.replies ?? [];

  return {
    from: { id: input.fromId ?? 12345 },
    chat: {
      id: input.chatId ?? (input.chatType === "private" ? 12345 : -1001),
      type: input.chatType,
      title: input.chatType === "private" ? undefined : "Builders"
    },
    message: { text: input.text, message_id: 1 },
    telegram: {
      getChatMember: vi.fn().mockResolvedValue({ status: "administrator" }),
      getChatAdministrators: vi.fn().mockResolvedValue([])
    },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
    replyWithPhoto: vi.fn(async (_photo: unknown, options: { caption?: string }) => {
      replies.push(options.caption ?? "");
    })
  } as never;
}

describe("Telegram private wallet privacy", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("/start in group does not call walletManager.getDepositAddress or include a deposit address", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const getDepositAddress = vi.spyOn(wm, "getDepositAddress");
    const replies: string[] = [];

    await createStartCommand({
      config,
      db,
      walletManager: wm,
      skillExecutor: {} as SkillExecutor
    })(makeTelegramContext({ text: "/start", chatType: "supergroup", replies }));

    expect(getDepositAddress).not.toHaveBeenCalled();
    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
    expect(replies.join("\n")).not.toContain("0xPRIVATE");
  });

  it("/start inline payload in group is refused before paid execution", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const skillExecutor = { execute: vi.fn() } as unknown as SkillExecutor;
    const { token } = createSignedInlinePayload(db, config.MASTER_ENCRYPTION_KEY, {
      skill: "research",
      sanitizedInput: "x402 adoption"
    });
    const replies: string[] = [];

    await createStartCommand({ config, db, walletManager: wm, skillExecutor })(
      makeTelegramContext({ text: `/start ${token}`, chatType: "group", replies })
    );

    expect(skillExecutor.execute).not.toHaveBeenCalled();
    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
    expect(db.sqlite.prepare("SELECT consumed_at FROM inline_payloads").get()).toMatchObject({
      consumed_at: null
    });
  });

  it("/deposit in group does not include a deposit address", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const getDepositAddress = vi.spyOn(wm, "getDepositAddress");
    const replies: string[] = [];

    await createDepositCommand({ config, db, walletManager: wm, skillExecutor: {} as SkillExecutor })(
      makeTelegramContext({ text: "/deposit", chatType: "group", replies })
    );

    expect(getDepositAddress).not.toHaveBeenCalled();
    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
    expect(replies.join("\n")).not.toContain("0xPRIVATE");
  });

  it("/balance in group does not include balance", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, config, ac);
    const replies: string[] = [];

    await createBalanceCommand({ config, db, walletManager: wm, skillExecutor: {} as SkillExecutor })(
      makeTelegramContext({ text: "/balance", chatType: "supergroup", replies })
    );

    expect(ac.getBalance).not.toHaveBeenCalled();
    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
    expect(replies.join("\n")).not.toContain("Balance:");
  });

  it("/history in group does not include transaction details", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const replies: string[] = [];

    await createHistoryCommand({ config, db, walletManager: wm, skillExecutor: {} as SkillExecutor })(
      makeTelegramContext({ text: "/history", chatType: "group", replies })
    );

    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
    expect(replies.join("\n")).not.toContain("Your last transactions:");
  });

  it("/research in group does not execute a user-wallet paid call", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const skillExecutor = { execute: vi.fn() } as unknown as SkillExecutor;
    const replies: string[] = [];

    await createResearchCommand({ config, db, walletManager: wm, skillExecutor })(
      makeTelegramContext({ text: "/research x402 adoption", chatType: "supergroup", replies })
    );

    expect(skillExecutor.execute).not.toHaveBeenCalled();
    expect(replies).toEqual([USER_WALLET_DM_INSTRUCTION]);
  });

  it("natural language text in group does not route to a paid call", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const routerClient = { routeMessage: vi.fn() } as unknown as RouterClient;
    const skillExecutor = { execute: vi.fn() } as unknown as SkillExecutor;
    const replies: string[] = [];

    await createNaturalLanguageTextHandler({
      config,
      db,
      walletManager: wm,
      skillExecutor,
      routerClient
    })(makeTelegramContext({ text: "research x402 adoption", chatType: "group", replies }));

    expect(routerClient.routeMessage).not.toHaveBeenCalled();
    expect(skillExecutor.execute).not.toHaveBeenCalled();
    expect(replies).toEqual(["Use /groupwallet help or DM me for private wallet commands."]);
  });

  it("private /start still returns wallet deposit details", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const replies: string[] = [];

    await createStartCommand({
      config,
      db,
      walletManager: wm,
      skillExecutor: {} as SkillExecutor
    })(makeTelegramContext({ text: "/start", chatType: "private", replies }));

    expect(replies[0]).toContain("Deposit address: 0xPRIVATE");
  });

  it("private /deposit still returns wallet deposit details", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const replies: string[] = [];

    await createDepositCommand({ config, db, walletManager: wm, skillExecutor: {} as SkillExecutor })(
      makeTelegramContext({ text: "/deposit", chatType: "private", replies })
    );

    expect(replies[0]).toContain("Deposit address: 0xPRIVATE");
  });

  it("group /groupwallet help still works", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const wm = new WalletManager(db, config, makeAgentCashClient());
    const replies: string[] = [];

    await createGroupWalletCommand({ config, db, walletManager: wm })(
      makeTelegramContext({ text: "/groupwallet help", chatType: "supergroup", replies })
    );

    expect(replies[0]).toContain("Group wallet commands:");
    expect(replies[0]).toContain("/groupwallet deposit");
  });

  it("group wallet confirmation still works for a group quote", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, config, ac);
    await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });
    const executor = new SkillExecutor(db, wm, ac, silentLogger, config);

    const result = await executor.execute("research", "x402 adoption", {
      telegramId: "12345",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      forceConfirmation: true
    });

    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    await expect(
      executor.executeApprovedQuote(result.quoteId, {
        telegramId: "12345",
        telegramChatId: "-1001",
        telegramChatType: "supergroup"
      })
    ).resolves.toMatchObject({ type: "completed" });
    expect(ac.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("user-wallet confirmation in group is rejected", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, config, ac);
    const executor = new SkillExecutor(db, wm, ac, silentLogger, config);

    const result = await executor.execute("research", "x402 adoption", {
      telegramId: "12345",
      telegramChatId: "12345",
      telegramChatType: "private",
      forceConfirmation: true
    });

    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    await expect(
      executor.executeApprovedQuote(result.quoteId, {
        telegramId: "12345",
        telegramChatId: "-1001",
        telegramChatType: "supergroup"
      })
    ).rejects.toThrow(QuoteError);
    expect(ac.fetchJson).not.toHaveBeenCalled();
  });
});
