import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillExecutor } from "../src/agentcash/skillExecutor.js";
import type { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { AppConfig } from "../src/config.js";
import { createGroupWalletCommand } from "../src/commands/groupWallet.js";
import { AppDatabase } from "../src/db/client.js";
import type { AppLogger } from "../src/lib/logger.js";
import { QuoteError } from "../src/lib/errors.js";
import { WalletManager } from "../src/wallets/walletManager.js";

const MASTER_KEY = Buffer.alloc(32, 43).toString("base64");

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

function makeAgentCashClient(overrides: Partial<AgentCashClient> = {}): AgentCashClient {
  return {
    checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} }),
    fetchJson: vi.fn().mockResolvedValue({ raw: {}, data: { results: [] }, actualCostCents: 1 }),
    getBalance: vi.fn().mockResolvedValue({ usdcBalance: 10, address: "0xGROUP", raw: {} }),
    ensureWallet: vi.fn().mockResolvedValue({
      address: "0xGROUP",
      network: "base",
      encryptedPrivateKey: "v1.iv.tag.ct",
      raw: {}
    }),
    getDepositInfo: vi.fn().mockResolvedValue({ address: "0xGROUP", raw: {} }),
    getHomeDir: vi.fn().mockReturnValue("/tmp/test"),
    extractImageUrl: vi.fn().mockReturnValue(undefined),
    extractJobId: vi.fn().mockReturnValue(undefined),
    extractJobLink: vi.fn().mockReturnValue(undefined),
    pollJob: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as AgentCashClient;
}

describe("group wallets", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("creates group wallets idempotently", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const ac = makeAgentCashClient();
    const wm = new WalletManager(db, makeConfig(), ac);

    const first = await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });
    const second = await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });

    expect(first.group?.id).toBe(second.group?.id);
    expect(first.wallet.id).toBe(second.wallet.id);
    expect(db.sqlite.prepare("SELECT * FROM groups").all()).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM wallets WHERE kind = 'group'").all()).toHaveLength(1);
    expect(ac.ensureWallet).toHaveBeenCalledTimes(1);
  });

  it("uses the group wallet for paid calls in group chats", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const ac = makeAgentCashClient({
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 1, raw: {} })
    });
    const wm = new WalletManager(db, makeConfig({ DEFAULT_SPEND_CAP_USDC: 5 }), ac);
    const group = await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });
    const executor = new SkillExecutor(db, wm, ac, silentLogger, makeConfig({ DEFAULT_SPEND_CAP_USDC: 5 }));

    const result = await executor.execute("research", "x402 protocol", {
      telegramId: "99999",
      telegramChatId: "-1001",
      telegramChatType: "supergroup"
    });

    expect(result.type).toBe("completed");
    expect(ac.checkEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: group.wallet.id, kind: "group" }),
      expect.any(String),
      expect.any(Object)
    );

    const transaction = db.sqlite.prepare("SELECT * FROM transactions").get() as {
      wallet_id: string;
      group_id: string;
      user_id: string;
    };
    const requester = db.getUserByTelegramId("99999")!;
    expect(transaction.wallet_id).toBe(group.wallet.id);
    expect(transaction.group_id).toBe(group.group!.id);
    expect(transaction.user_id).toBe(requester.id);
  });

  it("does not allow a non-admin to change the group cap", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const ac = makeAgentCashClient();
    const config = makeConfig();
    const wm = new WalletManager(db, config, ac);
    await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });
    const replies: string[] = [];
    const handler = createGroupWalletCommand({ config, db, walletManager: wm });

    await handler({
      from: { id: 99999 },
      chat: { id: -1001, type: "supergroup", title: "Builders" },
      message: { text: "/groupwallet cap 1" },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
      })
    } as never);

    expect(replies[0]).toContain("Only a group wallet owner or admin");
    expect(db.getGroupByTelegramChatHash(WalletManager.getHashedChatId("-1001", MASTER_KEY))!.spend_cap_usdc).toBe(0.5);
  });

  it("does not let a member approve someone else's over-cap group quote", async () => {
    db = new AppDatabase(":memory:");
    db.initialize();
    const config = makeConfig();
    const ac = makeAgentCashClient({
      checkEndpoint: vi.fn().mockResolvedValue({ estimatedCostCents: 100, raw: {} })
    });
    const wm = new WalletManager(db, config, ac);
    await wm.getOrCreateGroupWallet({
      chatId: "-1001",
      title: "Builders",
      createdByTelegramId: "12345"
    });
    const executor = new SkillExecutor(db, wm, ac, silentLogger, config);

    const result = await executor.execute("research", "x402 protocol", {
      telegramId: "99999",
      telegramChatId: "-1001",
      telegramChatType: "supergroup"
    });

    if (result.type !== "confirmation_required") throw new Error("expected confirmation");

    await expect(
      executor.executeApprovedQuote(result.quoteId, {
        telegramId: "88888",
        telegramChatId: "-1001",
        telegramChatType: "supergroup"
      })
    ).rejects.toThrow(QuoteError);

    expect(ac.fetchJson).not.toHaveBeenCalled();
  });
});
