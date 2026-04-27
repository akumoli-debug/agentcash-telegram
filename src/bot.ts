import { Telegraf, type Context } from "telegraf";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./lib/logger.js";
import { AppDatabase } from "./db/client.js";
import { WalletManager } from "./wallets/walletManager.js";
import { SkillExecutor } from "./agentcash/skillExecutor.js";
import { hashSensitiveValue, hashTelegramId } from "./lib/crypto.js";
import { createStartCommand } from "./commands/start.js";
import { createBalanceCommand } from "./commands/balance.js";
import { createDepositCommand } from "./commands/deposit.js";
import { createHelpCommand } from "./commands/help.js";
import { createResearchCommand } from "./commands/research.js";
import { createSearchCommand } from "./commands/search.js";
import { createEnrichCommand } from "./commands/enrich.js";
import { createGenerateCommand } from "./commands/generate.js";
import { createCapCommand } from "./commands/cap.js";
import { createHistoryCommand } from "./commands/history.js";
import { createGroupWalletCommand } from "./commands/groupWallet.js";
import { createPolicyCommand } from "./commands/policy.js";
import { createSpendCommand } from "./commands/spend.js";
import { createInlineQueryHandler } from "./commands/inlineMode.js";
import { executeSkillRequest } from "./commands/skillCommand.js";
import {
  ensureUserRecord,
  getCallbackData,
  getTelegramProfile,
  isPrivateTelegramChat,
  parseSessionQuoteState,
  replyDmInstructionForUserWalletCommand,
  replyWithSkillResult
} from "./commands/helpers.js";
import { replyWithError } from "./commands/replyWithError.js";
import { RouterClient, extractSkillInput } from "./router/routerClient.js";
import { QuoteError } from "./lib/errors.js";
import { assertTelegramGroupAdmin } from "./telegram/adminVerifier.js";
import { ResearchWorkflowService } from "./research/ResearchWorkflowService.js";
import { evaluatePolicy, type SecurityPolicyConfig } from "./gateway/securityPolicy.js";
import { issuePairingCode } from "./gateway/pairingStore.js";

export function createBot(deps: {
  config: AppConfig;
  logger: AppLogger;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
  researchWorkflowService?: ResearchWorkflowService;
  routerClient: RouterClient;
  securityPolicy: SecurityPolicyConfig;
}) {
  if (!deps.config.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to start the Telegram bot");
  }

  const bot = new Telegraf(deps.config.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const telegramIdHash = ctx.from?.id
      ? hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY)
      : undefined;
    const chatIdHash = ctx.chat?.id
      ? hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24)
      : undefined;

    deps.logger.info(
      { updateType: ctx.updateType, chatIdHash, telegramIdHash },
      "incoming Telegram update"
    );
    await next();
  });

  // Middleware: ignore bot self-messages and synthetic system messages.
  bot.use(async (ctx, next) => {
    if (ctx.from?.is_bot) {
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (!ctx.from) {
      await next();
      return;
    }

    const user = ensureUserRecord(deps.db, ctx, deps.config.DEFAULT_SPEND_CAP_USDC);

    if (ctx.from.id) {
      const userHash = hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY);
      deps.db.upsertDeliveryIdentity(userHash, String(ctx.from.id));
    }

    const result = deps.db.checkAndRecordRateLimit(user.id, {
      eventName: ctx.updateType,
      maxPerMinute: deps.config.RATE_LIMIT_MAX_PER_MINUTE,
      maxPerHour: deps.config.RATE_LIMIT_MAX_PER_HOUR
    });

    if (result.allowed) {
      await next();
      return;
    }

    deps.logger.warn(
      {
        telegramIdHash: hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY),
        minuteCount: result.minuteCount,
        hourCount: result.hourCount,
        updateType: ctx.updateType
      },
      "telegram rate limit exceeded"
    );

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Rate limit reached. Please try again shortly.");
      return;
    }

    await ctx.reply("Rate limit reached. Please wait a bit and try again.");
  });

  // Middleware: gateway security policy (allowlist, pairing, group guards).
  bot.use(async (ctx, next) => {
    if (!ctx.from || !ctx.chat) {
      await next();
      return;
    }

    const actorIdHash = hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY);
    const chatIdHash = hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24);

    const chatType = ctx.chat.type === "private"
      ? "private" as const
      : (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
      ? "group" as const
      : "channel" as const;

    const isCallbackQuery = Boolean(ctx.callbackQuery);

    // Determine command name for policy (strip bot @mention suffix).
    let commandName: string | undefined;
    let isCommand = false;
    const text = ctx.message && "text" in ctx.message ? ctx.message.text ?? "" : "";
    if (text.startsWith("/")) {
      isCommand = true;
      const firstWord = text.split(/\s+/)[0]!;
      commandName = firstWord.slice(1).split("@")[0]?.toLowerCase();
    }

    const botMentioned = detectTelegramMention(text, deps.config.TELEGRAM_BOT_USERNAME);

    const decision = evaluatePolicy(
      {
        platform: "telegram",
        actorIdHash,
        chatIdHash,
        chatType,
        isCommand,
        commandName,
        botWasMentioned: botMentioned,
        messageAuthorIsBot: ctx.from.is_bot ?? false,
        walletScopeRequested: chatType === "private" ? "user" : "group",
        isCallbackQuery
      },
      deps.securityPolicy
    );

    if (decision.result === "allow") {
      await next();
      return;
    }

    if (decision.result === "deny_silent") {
      return;
    }

    if (decision.result === "deny_with_dm_instruction") {
      await ctx.reply("DM me for private wallet commands. Use /groupwallet help here.");
      return;
    }

    if (decision.result === "deny_with_allowlist_message") {
      await ctx.reply("This bot is restricted to approved users. Contact the operator to request access.");
      return;
    }

    if (decision.result === "require_pairing") {
      const { code, expiresAt } = issuePairingCode(
        deps.db,
        "telegram",
        actorIdHash,
        deps.config.PAIRING_CODE_TTL_SECONDS
      );
      const expiresDisplay = new Date(expiresAt).toUTCString();
      await ctx.reply(
        `To use this bot, send your operator this pairing code:\n\n<code>${code}</code>\n\nExpires: ${expiresDisplay}`,
        { parse_mode: "HTML" }
      );
      return;
    }
  });

  bot.command("start", createStartCommand(deps));
  bot.command("help", createHelpCommand());
  bot.command("balance", createBalanceCommand(deps));
  bot.command("deposit", createDepositCommand(deps));
  bot.command("cap", createCapCommand(deps));
  bot.command("research", createResearchCommand(deps));
  bot.command("search", createSearchCommand(deps));
  bot.command("exa", createSearchCommand(deps));
  bot.command("enrich", createEnrichCommand(deps));
  bot.command("generate", createGenerateCommand(deps));
  bot.command("history", createHistoryCommand(deps));
  bot.command("freeze", async ctx => {
    if (!ctx.from || !ctx.chat) return;
    try {
      if (ctx.chat.type === "private") {
        deps.walletManager.freezeUserWallet(String(ctx.from.id));
        await ctx.reply("Your wallet is frozen. Balance, deposit, and history still work.");
        return;
      }

      const chatHash = hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24);
      const group = deps.db.getGroupByTelegramChatHash(chatHash);
      if (!group) {
        await ctx.reply("No group wallet exists yet.");
        return;
      }
      await assertTelegramGroupAdmin(ctx, String(ctx.chat.id), String(ctx.from.id));
      deps.walletManager.freezeGroupWallet(group.id);
      await ctx.reply("Group wallet is frozen. Balance, deposit, and history still work.");
    } catch (error) {
      deps.logger.warn({ err: error instanceof Error ? { name: error.name, message: error.message } : String(error) }, "freeze command failed");
      await replyWithError(ctx, error);
    }
  });
  bot.command("unfreeze", async ctx => {
    if (!ctx.from || !ctx.chat) return;
    try {
      if (ctx.chat.type === "private") {
        deps.walletManager.unfreezeUserWallet(String(ctx.from.id));
        await ctx.reply("Your wallet is active again.");
        return;
      }

      const chatHash = hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24);
      const group = deps.db.getGroupByTelegramChatHash(chatHash);
      const user = deps.db.getUserByTelegramId(String(ctx.from.id));
      if (!group || !user || !deps.walletManager.isGroupAdmin(group.id, user.id)) {
        await ctx.reply("Only a group wallet owner/admin can unfreeze this wallet.");
        return;
      }
      await assertTelegramGroupAdmin(ctx, String(ctx.chat.id), String(ctx.from.id));
      deps.walletManager.unfreezeGroupWallet(group.id);
      await ctx.reply("Group wallet is active again.");
    } catch (error) {
      deps.logger.warn({ err: error instanceof Error ? { name: error.name, message: error.message } : String(error) }, "unfreeze command failed");
      await replyWithError(ctx, error);
    }
  });
  bot.command("status", async ctx => {
    if (!ctx.from || !ctx.chat) return;
    if (ctx.chat.type === "private") {
      const wallet = deps.walletManager.getUserWalletStatus(String(ctx.from.id));
      await ctx.reply(`Wallet status: ${wallet?.status ?? "not created"}.`);
      return;
    }

    const chatHash = hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24);
    const group = deps.db.getGroupByTelegramChatHash(chatHash);
    const wallet = group ? deps.db.getWalletByGroupId(group.id) : undefined;
    await ctx.reply(`Group wallet status: ${wallet?.status ?? "not created"}.`);
  });
  bot.command("groupwallet", createGroupWalletCommand(deps));
  bot.command("policy", createPolicyCommand(deps));
  bot.command("spend", createSpendCommand(deps));

  bot.command("pair", async ctx => {
    if (!ctx.from || !ctx.chat) return;
    if (ctx.chat.type !== "private") {
      await ctx.reply("DM me to pair your account.");
      return;
    }
    const actorIdHash = hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY);
    if (deps.config.PAIRING_MODE !== "dm_code") {
      await ctx.reply("Pairing is not enabled on this bot.");
      return;
    }
    const { code, expiresAt } = issuePairingCode(
      deps.db,
      "telegram",
      actorIdHash,
      deps.config.PAIRING_CODE_TTL_SECONDS
    );
    const expiresDisplay = new Date(expiresAt).toUTCString();
    await ctx.reply(
      `Your pairing code:\n\n<code>${code}</code>\n\nShare this with the bot operator to get access. Expires: ${expiresDisplay}`,
      { parse_mode: "HTML" }
    );
  });

  bot.on("inline_query", createInlineQueryHandler(deps));

  bot.on("text", createNaturalLanguageTextHandler(deps));

  bot.action(/^confirm:/, async ctx => {
    try {
      const data = getCallbackData(ctx);
      const quoteId = data.slice("confirm:".length);
      const telegramId = String(ctx.from?.id ?? "");
      const chatId = String(ctx.chat?.id ?? "");
      if (!telegramId || !chatId) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      const user = deps.walletManager.getExistingUser(telegramId);
      const quote = deps.db.getQuote(quoteId);

      if (!quote) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      if (quote.group_id === null && !isPrivateTelegramChat(ctx)) {
        await ctx.answerCbQuery("DM me to confirm private wallet commands.");
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      const sessionUserId = quote?.requester_user_id ?? user.id;
      const session = deps.db.getSession(sessionUserId, chatId);
      const sessionState = parseSessionQuoteState(session);

      if (!sessionState || sessionState.quote_id !== quoteId) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      if (quote) {
        const userHash = hashTelegramId(telegramId, deps.config.MASTER_ENCRYPTION_KEY);
        const isRequester = quote.user_hash === userHash;

        if (quote.group_id === null) {
          if (!isRequester) {
            await ctx.answerCbQuery("This confirmation does not belong to your account.");
            return;
          }
        } else {
          const group = deps.db.getGroupById(quote.group_id);
          const expectedChatHash = WalletManager.getHashedChatId(
            chatId,
            deps.config.MASTER_ENCRYPTION_KEY
          );
          const isGroupAdmin = deps.walletManager.isGroupAdmin(quote.group_id, user.id);

          if (!group || group.telegram_chat_id_hash !== expectedChatHash) {
            await ctx.answerCbQuery("This group confirmation is no longer valid.");
            return;
          }

          if (!isRequester && !isGroupAdmin) {
            await ctx.answerCbQuery("This confirmation does not belong to your account.");
            return;
          }

          if (quote.requires_group_admin_approval) {
            if (!isGroupAdmin) {
              await ctx.answerCbQuery("Only a group wallet owner or admin can confirm this request.");
              return;
            }

            const telegramStatus = await assertTelegramGroupAdmin(ctx, chatId, telegramId);
            deps.db.recordTelegramAdminVerification({
              groupId: quote.group_id,
              userId: user.id,
              telegramStatus,
              source: "getChatMember"
            });
          }
        }
      }

      const stateJson = session?.state_json ?? "";
      const consumed = deps.db.consumeSessionState(sessionUserId, chatId, stateJson);
      if (!consumed) {
        await ctx.answerCbQuery("This confirmation was already used.");
        return;
      }

      const executionContext = {
        telegramId,
        telegramProfile: getTelegramProfile(ctx),
        telegramChatId: chatId,
        telegramChatType: ctx.chat?.type,
        telegramMessageId:
          ctx.callbackQuery && "message" in ctx.callbackQuery && ctx.callbackQuery.message
            ? String(ctx.callbackQuery.message.message_id)
            : null
      };
      const result =
        deps.researchWorkflowService?.isWorkflowQuote(quote)
          ? await deps.researchWorkflowService.executeApprovedQuote(quoteId, executionContext)
          : await deps.skillExecutor.executeApprovedQuote(quoteId, executionContext);

      await ctx.answerCbQuery("Confirmed.");
      await replyWithSkillResult(ctx, result);
    } catch (error) {
      if (error instanceof QuoteError) {
        await ctx.reply(error.message);
        return;
      }
      await replyWithError(ctx, error);
    }
  });

  bot.action(/^cancel:/, async ctx => {
    try {
      const data = getCallbackData(ctx);
      const quoteId = data.slice("cancel:".length);
      const telegramId = String(ctx.from?.id ?? "");
      const chatId = String(ctx.chat?.id ?? "");
      if (!telegramId || !chatId) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      const user = deps.walletManager.getExistingUser(telegramId);
      const quote = deps.db.getQuote(quoteId);

      if (!quote) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      if (quote.group_id === null && !isPrivateTelegramChat(ctx)) {
        await ctx.answerCbQuery("DM me to cancel private wallet commands.");
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      const sessionUserId = quote?.requester_user_id ?? user.id;
      const session = deps.db.getSession(sessionUserId, chatId);
      const sessionState = parseSessionQuoteState(session);

      if (!sessionState || sessionState.quote_id !== quoteId) {
        await ctx.answerCbQuery("This confirmation is no longer valid.");
        return;
      }

      if (quote) {
        const userHash = hashTelegramId(telegramId, deps.config.MASTER_ENCRYPTION_KEY);
        const isRequester = quote.user_hash === userHash;

        if (quote.group_id === null) {
          if (!isRequester) {
            await ctx.answerCbQuery("This confirmation does not belong to your account.");
            return;
          }
        } else {
          const group = deps.db.getGroupById(quote.group_id);
          const expectedChatHash = WalletManager.getHashedChatId(
            chatId,
            deps.config.MASTER_ENCRYPTION_KEY
          );
          const isGroupAdmin = deps.walletManager.isGroupAdmin(quote.group_id, user.id);

          if (!group || group.telegram_chat_id_hash !== expectedChatHash) {
            await ctx.answerCbQuery("This group confirmation is no longer valid.");
            return;
          }

          if (!isRequester && !isGroupAdmin) {
            await ctx.answerCbQuery("This confirmation does not belong to your account.");
            return;
          }
        }
      }

      const stateJson = session?.state_json ?? "";
      const consumed = deps.db.consumeSessionState(sessionUserId, chatId, stateJson);
      if (!consumed) {
        await ctx.answerCbQuery("This confirmation was already used.");
        return;
      }

      deps.db.updateQuoteStatus(quoteId, "canceled");
      await ctx.answerCbQuery("Cancelled.");
      await ctx.reply("Pending call cancelled.");
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  bot.catch(async (error, ctx) => {
    deps.logger.error(
      {
        err: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
        chatIdHash: ctx.chat?.id
          ? hashSensitiveValue(`chat:${String(ctx.chat.id)}`, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24)
          : undefined,
        telegramIdHash: ctx.from?.id
          ? hashTelegramId(String(ctx.from.id), deps.config.MASTER_ENCRYPTION_KEY)
          : undefined
      },
      "bot handler failed"
    );

    await ctx.reply("Something went wrong while handling that command.");
  });

  return bot;
}

export function detectTelegramMention(text: string, botUsername?: string): boolean {
  if (!text) return false;
  if (botUsername && text.includes(`@${botUsername}`)) return true;
  // Also detect when the bot is mentioned without a username (e.g. in replies where
  // Telegram omits the @, or when the username is unknown).
  return /@\w+bot\b/i.test(text);
}

export function createNaturalLanguageTextHandler(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
  researchWorkflowService?: ResearchWorkflowService;
  routerClient: RouterClient;
}) {
  return async (ctx: Context) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : "";

    if (!text || text.startsWith("/")) {
      return;
    }

    if (!isPrivateTelegramChat(ctx)) {
      // Group natural language is handled by the policy middleware (silently dropped
      // unless the bot was mentioned and the chat is in free-response bypass list).
      // Any group NL that reached here was allowed by the policy; still guard the
      // wallet path by redirecting — never execute a private wallet command in a group.
      await ctx.reply("Use /groupwallet help or DM me for private wallet commands.");
      return;
    }

    try {
      const decision = await deps.routerClient.routeMessage(text);

      if (!decision) {
        await ctx.reply(
          "Natural language routing is not configured. Use /research, /enrich, or /generate."
        );
        return;
      }

      if (decision.skill === "none" || decision.confidence < deps.config.ROUTER_CONFIDENCE_THRESHOLD) {
        await ctx.reply(
          "I'm not confident enough to route that safely. Use /research <query>, /enrich <email>, or /generate <prompt>."
        );
        return;
      }

      const rawInput = extractSkillInput(decision);

      if (!rawInput) {
        await ctx.reply(
          "I could not extract safe arguments from that message. Please use a slash command."
        );
        return;
      }

      await executeSkillRequest(
        ctx,
        {
          config: deps.config,
          db: deps.db,
          walletManager: deps.walletManager,
          skillExecutor: deps.skillExecutor,
          skillName: decision.skill
        },
        rawInput,
        { forceConfirmation: true }
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
