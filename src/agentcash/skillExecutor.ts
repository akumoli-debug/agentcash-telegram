import { z } from "zod";
import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import { AppDatabase, type GroupRow, type UserRow, type WalletRow } from "../db/client.js";
import { hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import {
  AgentCashError,
  InsufficientBalanceError,
  QuoteError,
  SpendingCapError,
  ValidationError
} from "../lib/errors.js";
import { defaultLockManager, type LockManager } from "../lib/lockManager.js";
import type { AppLogger } from "../lib/logger.js";
import { WalletManager, type TelegramProfile } from "../wallets/walletManager.js";
import { AgentCashClient, type AgentCashFetchResult } from "./agentcashClient.js";

export type SkillName = "research" | "enrich" | "generate";

export interface SkillExecutionContext {
  telegramId: string;
  telegramProfile?: TelegramProfile;
  telegramChatId: string;
  telegramChatType?: string;
  telegramMessageId?: string | null;
  forceConfirmation?: boolean;
}

export interface SkillRenderResult {
  text: string;
  imageUrl?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
}

export interface QuoteConfirmationResult {
  type: "confirmation_required";
  text: string;
  quoteId: string;
  skill: SkillName;
  quotedCostCents: number;
  expiresAt: string;
  isDevUnquoted: boolean;
}

export type SkillExecutionResult =
  | QuoteConfirmationResult
  | ({ type: "completed" } & SkillRenderResult);

interface SkillDefinition<TInput> {
  name: SkillName;
  endpoint: string;
  mayVary: boolean;
  validator: z.ZodType<TInput>;
  buildBody: (input: TInput) => Record<string, unknown>;
  sanitizeInput: (input: TInput, requestHash: string) => string;
  formatResult: (
    fetchResult: AgentCashFetchResult,
    helpers: { agentcashClient: AgentCashClient; wallet: WalletRow }
  ) => Promise<Omit<SkillRenderResult, "estimatedCostCents" | "actualCostCents">>;
}

const researchValidator = z.string().trim().min(3, "Please provide a research query.");
const enrichValidator = z.string().trim().email("Please provide a valid email address.");
const generateValidator = z.string().trim().min(3, "Please provide an image prompt.");

const researchSkill: SkillDefinition<string> = {
  name: "research",
  endpoint: "https://stableenrich.dev/api/exa/search",
  mayVary: false,
  validator: researchValidator,
  buildBody: query => ({
    numResults: 5,
    query,
    type: "neural"
  }),
  sanitizeInput: (_query, requestHash) => `research:${requestHash.slice(0, 12)}`,
  formatResult: async fetchResult => {
    const results = extractResultItems(fetchResult.data).slice(0, 3);

    if (results.length === 0) {
      return { text: "Research completed, but no matching results were returned." };
    }

    return {
      text: [
        "Research results:",
        ...results.map((result, index) =>
          `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ""}`
        )
      ].join("\n\n")
    };
  }
};

const enrichSkill: SkillDefinition<string> = {
  name: "enrich",
  endpoint: "https://stableenrich.dev/api/apollo/people-enrich",
  mayVary: false,
  validator: enrichValidator,
  buildBody: email => ({ email }),
  sanitizeInput: (_email, requestHash) => `enrich:${requestHash.slice(0, 12)}`,
  formatResult: async fetchResult => {
    const object = firstObject(fetchResult.data) ?? {};
    const lines = [
      pickFirstString(object, ["name", "full_name"]),
      pickFirstString(object, ["title", "headline"]),
      pickFirstString(object, ["organization_name", "company", "company_name"]),
      pickFirstString(object, ["linkedin_url", "linkedin"]),
      pickFirstString(object, ["city", "location"])
    ].filter(Boolean) as string[];

    if (lines.length === 0) {
      return { text: "Enrichment completed, but no concise profile fields were available." };
    }

    return { text: ["Enrichment result:", ...lines].join("\n") };
  }
};

const generateSkill: SkillDefinition<string> = {
  name: "generate",
  endpoint: "https://stablestudio.dev/api/generate/nano-banana/generate",
  mayVary: false,
  validator: generateValidator,
  buildBody: prompt => ({ aspectRatio: "1:1", prompt }),
  sanitizeInput: (_prompt, requestHash) => `generate:${requestHash.slice(0, 12)}`,
  formatResult: async (fetchResult, helpers) => {
    let workingResult = fetchResult;
    let imageUrl =
      helpers.agentcashClient.extractImageUrl(fetchResult.data) ??
      helpers.agentcashClient.extractJobLink(fetchResult.data);

    if (!imageUrl) {
      const jobId = helpers.agentcashClient.extractJobId(fetchResult.data);
      if (jobId) {
        workingResult = await helpers.agentcashClient.pollJob(
          helpers.wallet,
          `https://stablestudio.dev/api/jobs/${jobId}`
        );
        imageUrl =
          helpers.agentcashClient.extractImageUrl(workingResult.data) ??
          helpers.agentcashClient.extractJobLink(workingResult.data);
      }
    }

    return {
      text: imageUrl ? "Image generation completed." : "Generation completed. No image URL was returned.",
      imageUrl
    };
  }
};

const skillDefinitions: Record<SkillName, SkillDefinition<string>> = {
  research: researchSkill,
  enrich: enrichSkill,
  generate: generateSkill
};

const EXECUTION_LOCK_TTL_MS = 120_000;
const EXECUTION_LEASE_TTL_MS = 120_000;

export function makeUpstreamIdempotencyKey(input: {
  quoteId: string;
  walletId: string;
  requestHash: string;
}): string {
  return `agentcash:${crypto
    .createHash("sha256")
    .update(`${input.quoteId}:${input.walletId}:${input.requestHash}`)
    .digest("hex")}`;
}

export class SkillExecutor {
  constructor(
    private readonly db: AppDatabase,
    private readonly walletManager: WalletManager,
    private readonly agentcashClient: AgentCashClient,
    private readonly logger: AppLogger,
    private readonly config: AppConfig,
    private readonly lockManager: LockManager = defaultLockManager
  ) {}

  getSkillDefinition(name: SkillName): SkillDefinition<string> {
    return skillDefinitions[name];
  }

  async execute(
    skillName: SkillName,
    rawInput: string,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const skill = this.getSkillDefinition(skillName);
    const input = skill.validator.safeParse(rawInput);

    if (!input.success) {
      throw new ValidationError(input.error.issues[0]?.message ?? "Invalid command input");
    }

    const body = skill.buildBody(input.data);
    const canonicalJson = canonicalizeJson(body);
    const userHash = hashTelegramId(context.telegramId, this.config.MASTER_ENCRYPTION_KEY);
    const requestHash = hashSensitiveValue(canonicalJson, this.config.MASTER_ENCRYPTION_KEY);

    return this.lockManager.withLock(`actor:${userHash}`, EXECUTION_LOCK_TTL_MS, async () => {
      const walletContext = await this._getWallet(context, userHash, skill.name);
      const { user, wallet, group } = walletContext;
      this.assertWalletCanSpend(wallet);
      this.assertRateLimit(user.id, "quote_preflight", this.config.RATE_LIMIT_QUOTE_MAX_PER_MINUTE);

      const balance = await this._getBalance(wallet, userHash, skill.name);

      const { quotedCostCents, isDevUnquoted } = await this._getQuote(
        wallet,
        skill,
        body,
        userHash,
        requestHash
      );
      this.assertGroupDailyCap(group, quotedCostCents, userHash, wallet.id, skill.name, requestHash);

      const hardCapCents = Math.round(this.config.HARD_SPEND_CAP_USDC * 100);

      if (!this.config.ALLOW_HIGH_VALUE_CALLS && quotedCostCents > hardCapCents) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: wallet.id,
          skill: skill.name,
          endpoint: skill.endpoint,
          requestHash,
          failureStage: "cap",
          errorCode: "HARD_CAP_EXCEEDED",
          safeErrorMessage: "Request exceeds hard MVP safety cap"
        });
        throw new SpendingCapError("This request exceeds the hard MVP safety cap.", {
          quotedCostCents,
          hardCapCents
        });
      }

      if (
        typeof balance.usdcBalance === "number" &&
        balance.usdcBalance * 100 < quotedCostCents
      ) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: wallet.id,
          skill: skill.name,
          endpoint: skill.endpoint,
          requestHash,
          failureStage: "balance",
          errorCode: "INSUFFICIENT_BALANCE",
          safeErrorMessage: "Wallet balance below quoted cost"
        });
        throw new InsufficientBalanceError("Your AgentCash wallet does not have enough balance.", {
          balanceUsdc: balance.usdcBalance,
          quotedCostCents
        });
      }

      const maxApprovedCostCents = Math.min(Math.max(quotedCostCents * 2, quotedCostCents + 10), hardCapCents);
      const expiresAt = new Date(
        Date.now() + this.config.PENDING_CONFIRMATION_TTL_SECONDS * 1000
      ).toISOString();

      const confirmationCap = group
        ? this.walletManager.getGroupConfirmationCap(group)
        : this.walletManager.getConfirmationCap(user);
      const requiresGroupAdminApproval =
        Boolean(group) &&
        confirmationCap !== undefined &&
        quotedCostCents > Math.round(confirmationCap * 100);

      const quote = this.db.createQuote({
        userHash,
        walletId: wallet.id,
        skill: skill.name,
        endpoint: skill.endpoint,
        canonicalRequestJson: canonicalJson,
        requestHash,
        quotedCostCents,
        maxApprovedCostCents,
        isDevUnquoted,
        expiresAt,
        requesterUserId: user.id,
        groupId: group?.id ?? null,
        requiresGroupAdminApproval,
        platform: context.telegramId.startsWith("discord:") ? "discord" : "telegram",
        actorIdHash: userHash,
        walletScope: group ? (group.platform === "discord" ? "discord_guild" : "telegram_group") : "user"
      });

      const needsConfirmation =
        context.forceConfirmation ||
        (confirmationCap !== undefined && quotedCostCents > Math.round(confirmationCap * 100));

      if (needsConfirmation) {
        const costLine = isDevUnquoted
          ? `This ${skill.name} call may incur a charge (dev mode: price unknown).`
          : `This ${skill.name} call is quoted at ${formatUsdCents(quotedCostCents)}.`;
        const capLine =
          confirmationCap !== undefined
            ? group
              ? `This group's per-call cap is ${formatUsdCents(Math.round(confirmationCap * 100))}.`
              : `Your per-call confirmation cap is ${formatUsdCents(Math.round(confirmationCap * 100))}.`
            : "Natural language requests always require confirmation.";
        const approvalLine = requiresGroupAdminApproval
          ? "Because this is over the group cap, an owner or admin must confirm."
          : "Confirm to proceed or cancel to stop.";
        const expiryMin = Math.ceil(this.config.PENDING_CONFIRMATION_TTL_SECONDS / 60);

        return {
          type: "confirmation_required",
          text: [
            costLine,
            capLine,
            `This confirmation expires in ${expiryMin} minute${expiryMin !== 1 ? "s" : ""}.`,
            approvalLine
          ].join("\n"),
          quoteId: quote.id,
          skill: skill.name,
          quotedCostCents,
          expiresAt: quote.expires_at,
          isDevUnquoted
        };
      }

      const approved = this.db.atomicApproveQuote(quote.id);
      if (!approved) {
        throw new QuoteError("Quote could not be approved. Please try again.");
      }

      return this._runApprovedQuote(quote.id, wallet, JSON.parse(canonicalJson) as Record<string, unknown>, skill, userHash);
    });
  }

  /**
   * Executes a quote that was previously created and shown to the user for confirmation.
   * Called from the bot's confirm callback handler — NOT from execute().
   */
  async executeApprovedQuote(
    quoteId: string,
    context: SkillExecutionContext
  ): Promise<{ type: "completed" } & SkillRenderResult> {
    const userHash = hashTelegramId(context.telegramId, this.config.MASTER_ENCRYPTION_KEY);

    return this.lockManager.withLock(`actor:${userHash}`, EXECUTION_LOCK_TTL_MS, async () =>
      this.lockManager.withLock(`quote:${quoteId}`, EXECUTION_LOCK_TTL_MS, async () => {
      const quote = this.db.getQuote(quoteId);

      if (!quote) {
        this.db.logPreflightAttempt({
          userHash,
          skill: "unknown",
          failureStage: "replay",
          errorCode: "QUOTE_NOT_FOUND",
          safeErrorMessage: "Quote not found during confirm"
        });
        throw new QuoteError("This confirmation is no longer valid.");
      }

      const group = quote.group_id ? this.db.getGroupById(quote.group_id) : undefined;
      const confirmerUser = this.db.getUserByTelegramId(context.telegramId);
      const chatHash =
        group?.platform === "discord"
          ? WalletManager.getHashedDiscordGuildId(context.telegramChatId, this.config.MASTER_ENCRYPTION_KEY)
          : WalletManager.getHashedChatId(context.telegramChatId, this.config.MASTER_ENCRYPTION_KEY);

      if (quote.group_id && !group) {
        throw new QuoteError("This group confirmation is no longer valid.");
      }

      if (!group && quote.user_hash !== userHash) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: quote.wallet_id,
          skill: quote.skill,
          failureStage: "replay",
          errorCode: "QUOTE_OWNER_MISMATCH",
          safeErrorMessage: "Quote ownership mismatch during confirm"
        });
        throw new QuoteError("This confirmation does not belong to your account.");
      }

      if (!group && context.telegramChatType && context.telegramChatType !== "private") {
        this.db.logPreflightAttempt({
          userHash,
          walletId: quote.wallet_id,
          skill: quote.skill,
          failureStage: "replay",
          errorCode: "USER_QUOTE_CONFIRMED_FROM_GROUP",
          safeErrorMessage: "User wallet quote confirmed from a non-private chat"
        });
        throw new QuoteError("Private wallet confirmations must be completed in a DM with the bot.");
      }

      if (group) {
        if (
          group.platform === "telegram" &&
          context.telegramChatType &&
          context.telegramChatType !== "group" &&
          context.telegramChatType !== "supergroup"
        ) {
          this.db.logPreflightAttempt({
            userHash,
            walletId: quote.wallet_id,
            skill: quote.skill,
            failureStage: "replay",
            errorCode: "GROUP_QUOTE_CONFIRMED_OUTSIDE_GROUP",
            safeErrorMessage: "Group quote confirmed outside a Telegram group"
          });
          throw new QuoteError("This group confirmation is no longer valid.");
        }

        if (group.telegram_chat_id_hash !== chatHash) {
          this.db.logPreflightAttempt({
            userHash,
            walletId: quote.wallet_id,
            skill: quote.skill,
            failureStage: "replay",
            errorCode: "QUOTE_GROUP_CHAT_MISMATCH",
            safeErrorMessage: "Group quote confirmed from a different chat"
          });
          throw new QuoteError("This group confirmation is no longer valid.");
        }

        const isRequester = quote.user_hash === userHash;
        const isAdmin =
          Boolean(confirmerUser) && this.walletManager.isGroupAdmin(group.id, confirmerUser!.id);

        if (quote.requires_group_admin_approval && !isAdmin) {
          this.db.logPreflightAttempt({
            userHash,
            walletId: quote.wallet_id,
            skill: quote.skill,
            failureStage: "replay",
            errorCode: "GROUP_APPROVER_NOT_AUTHORIZED",
            safeErrorMessage: "Non-admin attempted to approve over-cap group quote"
          });
          throw new QuoteError("Only a group wallet owner or admin can confirm this over-cap request.");
        }

        if (
          quote.requires_group_admin_approval &&
          !this.db.hasFreshTelegramAdminVerification(group.id, confirmerUser!.id)
        ) {
          this.db.logPreflightAttempt({
            userHash,
            walletId: quote.wallet_id,
            skill: quote.skill,
            failureStage: "replay",
            errorCode: "TELEGRAM_ADMIN_VERIFICATION_STALE",
            safeErrorMessage: "Over-cap group quote approval lacked fresh Telegram admin verification"
          });
          throw new QuoteError(
            "Telegram admin verification is required before approving this over-cap group request."
          );
        }

        if (!quote.requires_group_admin_approval && !isRequester && !isAdmin) {
          this.db.logPreflightAttempt({
            userHash,
            walletId: quote.wallet_id,
            skill: quote.skill,
            failureStage: "replay",
            errorCode: "QUOTE_OWNER_MISMATCH",
            safeErrorMessage: "Non-requester attempted to confirm group quote"
          });
          throw new QuoteError("This confirmation does not belong to your account.");
        }
      }

      if (quote.status !== "pending") {
        this.db.logPreflightAttempt({
          userHash,
          walletId: quote.wallet_id,
          skill: quote.skill,
          failureStage: "replay",
          errorCode: `QUOTE_STATUS_${quote.status.toUpperCase()}`,
          safeErrorMessage: `Replay attempt on quote with status=${quote.status}`
        });
        throw new QuoteError("This confirmation has already been used or has expired.");
      }

      if (new Date(quote.expires_at) <= new Date()) {
        this.db.updateQuoteStatus(quoteId, "expired");
        this.db.logPreflightAttempt({
          userHash,
          walletId: quote.wallet_id,
          skill: quote.skill,
          failureStage: "expired",
          errorCode: "QUOTE_EXPIRED",
          safeErrorMessage: "Quote expired before confirmation"
        });
        throw new QuoteError("This confirmation has expired. Please rerun the command.");
      }

      const approved = this.db.atomicApproveQuote(quoteId);
      if (!approved) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: quote.wallet_id,
          skill: quote.skill,
          failureStage: "replay",
          errorCode: "ATOMIC_APPROVE_FAILED",
          safeErrorMessage: "Atomic approve failed — concurrent confirm attempt"
        });
        throw new QuoteError("This confirmation was already used.");
      }

      const wallet = this.db.getWalletById(quote.wallet_id);
      if (!wallet) {
        throw new AgentCashError("Wallet not found for this confirmation.");
      }

      const skill = this.getSkillDefinition(quote.skill as SkillName);
      const requestBody = JSON.parse(quote.canonical_request_json) as Record<string, unknown>;

        return this._runApprovedQuote(quoteId, wallet, requestBody, skill, quote.user_hash);
      })
    );
  }

  private async _getWallet(
    context: SkillExecutionContext,
    userHash: string,
    skillName: string
  ): Promise<{ user: UserRow; wallet: WalletRow; group?: GroupRow }> {
    try {
      if (context.telegramChatType && context.telegramChatType !== "private") {
        if (context.telegramChatType === "discord_guild") {
          const discordUserId = context.telegramId.replace(/^discord:/, "");
          const groupContext = await this.walletManager.getDiscordGuildWalletForGuild(
            context.telegramChatId,
            discordUserId
          );

          if (!groupContext) {
            throw new ValidationError(
              "This Discord server does not have a guild wallet yet. Ask a server manager to run /ac guild create first."
            );
          }

          return groupContext;
        }

        const groupContext = await this.walletManager.getGroupWalletForTelegramChat(
          context.telegramChatId,
          context.telegramId
        );

        if (!groupContext) {
          throw new ValidationError(
            "This group does not have a wallet yet. Ask an owner to run /groupwallet create first."
          );
        }

        return groupContext;
      }

      return await this.walletManager.getOrCreateWalletForTelegramUser(
        context.telegramId,
        context.telegramProfile
      );
    } catch (error) {
      this.db.logPreflightAttempt({
        userHash,
        skill: skillName,
        failureStage: "wallet",
        errorCode: error instanceof Error ? (error as { code?: string }).code ?? "WALLET_ERROR" : "WALLET_ERROR",
        safeErrorMessage: "Wallet provisioning failed"
      });
      throw error;
    }
  }

  private async _getBalance(wallet: WalletRow, userHash: string, skillName: string) {
    try {
      return await this.agentcashClient.getBalance(wallet);
    } catch (error) {
      this.db.logPreflightAttempt({
        userHash,
        walletId: wallet.id,
        skill: skillName,
        failureStage: "balance",
        errorCode: error instanceof Error ? (error as { code?: string }).code ?? "BALANCE_ERROR" : "BALANCE_ERROR",
        safeErrorMessage: "Balance lookup failed"
      });
      throw error;
    }
  }

  private async _getQuote(
    wallet: WalletRow,
    skill: SkillDefinition<string>,
    body: Record<string, unknown>,
    userHash: string,
    requestHash: string
  ): Promise<{ quotedCostCents: number; isDevUnquoted: boolean }> {
    try {
      const checkResult = await this.agentcashClient.checkEndpoint(wallet, skill.endpoint, body);

      if (checkResult.estimatedCostCents === undefined) {
        throw new QuoteError("AgentCash did not return a bounded cost estimate.");
      }

      return { quotedCostCents: checkResult.estimatedCostCents, isDevUnquoted: false };
    } catch (error) {
      if (this.config.ALLOW_UNQUOTED_DEV_CALLS) {
        this.logger.warn(
          { skill: skill.name, userHash, requestHash },
          "dev: ALLOW_UNQUOTED_DEV_CALLS proceeding without bounded quote"
        );
        return { quotedCostCents: 0, isDevUnquoted: true };
      }

      this.db.logPreflightAttempt({
        userHash,
        walletId: wallet.id,
        skill: skill.name,
        endpoint: skill.endpoint,
        requestHash,
        failureStage: "quote",
        errorCode: error instanceof Error ? (error as { code?: string }).code ?? "QUOTE_FAILED" : "QUOTE_FAILED",
        safeErrorMessage: "AgentCash quote/check failed"
      });

      throw new QuoteError(
        "I couldn't safely quote this request, so I didn't run it. Please try again."
      );
    }
  }

  private async _runApprovedQuote(
    quoteId: string,
    wallet: WalletRow,
    requestBody: Record<string, unknown>,
    skill: SkillDefinition<string>,
    userHash: string
  ): Promise<{ type: "completed" } & SkillRenderResult> {
    const quote = this.db.getQuote(quoteId)!;
    const requesterUserId = quote.requester_user_id ?? wallet.owner_user_id;
    this.assertWalletCanSpend(wallet);

    if (!requesterUserId) {
      throw new AgentCashError("Requester not found for this confirmation.");
    }
    this.assertRateLimit(
      requesterUserId,
      "paid_execution",
      this.config.RATE_LIMIT_PAID_EXECUTION_MAX_PER_MINUTE
    );

    const upstreamIdempotencyKey =
      quote.upstream_idempotency_key ??
      makeUpstreamIdempotencyKey({
        quoteId,
        walletId: wallet.id,
        requestHash: quote.request_hash
      });
    const leaseExpiresAt = new Date(Date.now() + EXECUTION_LEASE_TTL_MS).toISOString();

    if (!this.db.atomicBeginQuoteExecution(quoteId, { leaseExpiresAt, upstreamIdempotencyKey })) {
      this.db.logPreflightAttempt({
        userHash,
        walletId: wallet.id,
        skill: skill.name,
        endpoint: skill.endpoint,
        requestHash: quote.request_hash,
        failureStage: "replay",
        errorCode: "QUOTE_EXECUTION_ALREADY_STARTED",
        safeErrorMessage: "Quote execution was already started by another worker"
      });
      throw new QuoteError("This confirmation was already used.");
    }

    try {
      const fetchResult = await this.agentcashClient.fetchJson(wallet, skill.endpoint, requestBody, {
        idempotencyKey: upstreamIdempotencyKey
      });
      const responseHash = hashSensitiveValue(
        JSON.stringify(fetchResult.data),
        this.config.MASTER_ENCRYPTION_KEY
      );
      const rendered = await skill.formatResult(fetchResult, {
        agentcashClient: this.agentcashClient,
        wallet
      });

      const transaction = this.db.createTransaction({
        userId: requesterUserId,
        walletId: wallet.id,
        groupId: quote.group_id ?? null,
        telegramChatId: userHash,
        telegramIdHash: userHash,
        commandName: skill.name,
        skill: skill.name,
        endpoint: skill.endpoint,
        quoteId,
        idempotencyKey: upstreamIdempotencyKey,
        status: "success",
        estimatedCostCents: quote.quoted_cost_cents,
        quotedPriceUsdc: Number((quote.quoted_cost_cents / 100).toFixed(6)),
        actualCostCents: fetchResult.actualCostCents ?? null,
        actualPriceUsdc:
          fetchResult.actualCostCents === undefined
            ? null
            : Number((fetchResult.actualCostCents / 100).toFixed(6)),
        requestHash: quote.request_hash,
        responseHash,
        txHash: fetchResult.txHash ?? null
      }) as { id: string };

      this.db.transitionQuoteStatus(quoteId, "executing", "succeeded", {
        executedAt: new Date().toISOString(),
        transactionId: transaction.id
      });

      this.logger.info(
        {
          skill: skill.name,
          walletId: wallet.id,
          userHash,
          quoteId,
          requestHash: quote.request_hash,
          responseHash,
          quotedCostCents: quote.quoted_cost_cents,
          actualCostCents: fetchResult.actualCostCents ?? null,
          isDevUnquoted: quote.is_dev_unquoted === 1,
          status: "success"
        },
        "skill execution completed"
      );

      return {
        type: "completed",
        ...rendered,
        estimatedCostCents: quote.quoted_cost_cents,
        actualCostCents: fetchResult.actualCostCents
      };
    } catch (error) {
      const responseHash =
        error instanceof Error
          ? hashSensitiveValue(error.message, this.config.MASTER_ENCRYPTION_KEY)
          : undefined;
      const safeError = safeExecutionErrorMessage(error);

      this.db.transitionQuoteStatus(quoteId, "executing", "execution_unknown", {
        lastExecutionError: safeError
      });

      this.logger.warn(
        {
          skill: skill.name,
          walletId: wallet.id,
          userHash,
          quoteId,
          requestHash: quote.request_hash,
          responseHash,
          quotedCostCents: quote.quoted_cost_cents,
          upstreamIdempotencyKey,
          status: "execution_unknown"
        },
        "skill execution became ambiguous and requires reconciliation"
      );

      this.db.logPreflightAttempt({
        userHash,
        walletId: wallet.id,
        skill: skill.name,
        endpoint: skill.endpoint,
        requestHash: quote.request_hash,
        failureStage: "execution",
        errorCode:
          error instanceof Error && "code" in error
            ? String((error as { code?: string }).code ?? "EXEC_ERROR")
            : "EXEC_ERROR",
        safeErrorMessage: safeError
      });

      throw error instanceof Error
        ? error
        : new AgentCashError("Skill execution failed", { cause: String(error) });
    }
  }

  private assertWalletCanSpend(wallet: WalletRow): void {
    if (wallet.status === "disabled") {
      throw new ValidationError("This wallet is frozen. Balance, deposit, and history still work.");
    }
  }

  private assertRateLimit(userId: string, eventName: string, maxPerMinute: number): void {
    const minuteLimit = maxPerMinute ?? 8;
    const result = this.db.checkAndRecordRateLimit(userId, {
      eventName,
      maxPerMinute: minuteLimit,
      maxPerHour: Math.max(minuteLimit, minuteLimit * 12)
    });

    if (!result.allowed) {
      throw new ValidationError("Rate limit reached. Please retry later.");
    }
  }

  private assertGroupDailyCap(
    group: GroupRow | undefined,
    quotedCostCents: number,
    userHash: string,
    walletId: string,
    skillName: string,
    requestHash: string
  ): void {
    if (!group) {
      return;
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const spent = this.db.getDailySpendCentsForGroup(group.id, since);
    const limit = Math.round((this.config.GROUP_DAILY_CAP_USDC ?? 25) * 100);

    if (spent + quotedCostCents <= limit) {
      return;
    }

    this.db.logPreflightAttempt({
      userHash,
      walletId,
      skill: skillName,
      requestHash,
      failureStage: "cap",
      errorCode: "GROUP_DAILY_CAP_EXCEEDED",
      safeErrorMessage: "Group daily cap exceeded"
    });

    throw new SpendingCapError("This group wallet has reached its daily spend cap.");
  }
}

function safeExecutionErrorMessage(error: unknown): string {
  const code =
    error instanceof Error && "code" in error
      ? String((error as { code?: string }).code ?? "UNKNOWN")
      : "UNKNOWN";
  const name = error instanceof Error ? error.name : "UnknownError";
  return `Execution outcome is unknown after upstream call started; operator reconciliation required (${name}:${code}).`;
}

/**
 * Stable JSON canonicalization: sorts object keys recursively so the same
 * logical request always produces the same byte string and therefore the
 * same hash, regardless of insertion order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ":" + canonicalizeJson(obj[k]));
  return "{" + pairs.join(",") + "}";
}

function extractResultItems(data: unknown): Array<{ title: string; url: string; snippet?: string }> {
  const array = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] } | null)?.results)
    ? ((data as { results: unknown[] }).results ?? [])
    : [];

  return array
    .map(item => {
      const object = firstObject(item);
      if (!object) return null;

      const title = pickFirstString(object, ["title", "name"]);
      const url = pickFirstString(object, ["url", "link"]);
      const snippet = pickFirstString(object, ["snippet", "text", "summary"]);

      if (!title || !url) return null;
      return { title, url, snippet };
    })
    .filter(Boolean) as Array<{ title: string; url: string; snippet?: string }>;
}

function firstObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstObject(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function pickFirstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
