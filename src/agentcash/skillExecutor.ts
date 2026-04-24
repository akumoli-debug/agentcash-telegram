import crypto from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AppDatabase, type WalletRow } from "../db/client.js";
import { decryptSecret, encryptSecret, hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import {
  AgentCashError,
  InsufficientBalanceError,
  SpendingCapError,
  ValidationError
} from "../lib/errors.js";
import type { AppLogger } from "../lib/logger.js";
import { WalletManager, type TelegramProfile } from "../wallets/walletManager.js";
import { AgentCashClient, type AgentCashFetchResult } from "./agentcashClient.js";

export type SkillName = "research" | "enrich" | "generate";

export interface SkillExecutionContext {
  telegramId: string;
  telegramProfile?: TelegramProfile;
  telegramChatId: string;
  telegramMessageId?: string | null;
  confirmed?: boolean;
  forceConfirmation?: boolean;
}

export interface SkillRenderResult {
  text: string;
  imageUrl?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
}

export interface PendingConfirmation {
  version: 1;
  type: "skill_confirmation";
  token: string;
  skill: SkillName;
  endpoint: string;
  sanitizedSummary: string;
  encryptedInput: string;
  requestHash: string;
  telegramIdHash: string;
  estimatedCostCents?: number;
  costMayVary?: boolean;
  expiresAt: string;
}

type SkillExecutionResult =
  | {
      type: "confirmation_required";
      text: string;
      pending: PendingConfirmation;
    }
  | ({
      type: "completed";
    } & SkillRenderResult);

interface SkillDefinition<TInput> {
  name: SkillName;
  endpoint: string;
  fallbackEstimatedCostCents?: number;
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

export const researchSkill: SkillDefinition<string> = {
  name: "research",
  endpoint: "https://stableenrich.dev/api/exa/search",
  fallbackEstimatedCostCents: 1,
  mayVary: false,
  validator: researchValidator,
  buildBody: query => ({
    query,
    numResults: 5,
    type: "neural"
  }),
  sanitizeInput: (_query, requestHash) => `research:${requestHash.slice(0, 12)}`,
  formatResult: async fetchResult => {
    const results = extractResultItems(fetchResult.data).slice(0, 3);

    if (results.length === 0) {
      return {
        text: "Research completed, but no matching results were returned."
      };
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

export const enrichSkill: SkillDefinition<string> = {
  name: "enrich",
  endpoint: "https://stableenrich.dev/api/apollo/people-enrich",
  fallbackEstimatedCostCents: 5,
  mayVary: false,
  validator: enrichValidator,
  buildBody: email => ({
    email
  }),
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
      return {
        text: "Enrichment completed, but no concise profile fields were available."
      };
    }

    return {
      text: ["Enrichment result:", ...lines].join("\n")
    };
  }
};

export const generateSkill: SkillDefinition<string> = {
  name: "generate",
  endpoint: "https://stablestudio.dev/api/generate/nano-banana/generate",
  fallbackEstimatedCostCents: 4,
  mayVary: false,
  validator: generateValidator,
  buildBody: prompt => ({
    prompt,
    aspectRatio: "1:1"
  }),
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
      text: imageUrl
        ? "Image generation completed."
        : "Generation completed. No image URL was returned.",
      imageUrl
    };
  }
};

const skillDefinitions: Record<SkillName, SkillDefinition<string>> = {
  research: researchSkill,
  enrich: enrichSkill,
  generate: generateSkill
};

export class SkillExecutor {
  constructor(
    private readonly db: AppDatabase,
    private readonly walletManager: WalletManager,
    private readonly agentcashClient: AgentCashClient,
    private readonly logger: AppLogger,
    private readonly config: AppConfig
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
    const telegramIdHash = hashTelegramId(
      context.telegramId,
      this.config.MASTER_ENCRYPTION_KEY
    );
    const requestHash = hashSensitiveValue(
      JSON.stringify(body),
      this.config.MASTER_ENCRYPTION_KEY
    );
    const sanitizedSummary = skill.sanitizeInput(input.data, requestHash);

    const { user, wallet } = await this.walletManager.getOrCreateWalletForTelegramUser(
      context.telegramId,
      context.telegramProfile
    );
    const balance = await this.agentcashClient.getBalance(wallet);
    const checkResult = await this.agentcashClient
      .checkEndpoint(wallet, skill.endpoint, body)
      .catch(() => ({ estimatedCostCents: undefined, raw: null }));
    const costMayVary = checkResult.estimatedCostCents === undefined;

    const estimatedCostCents =
      checkResult.estimatedCostCents ?? skill.fallbackEstimatedCostCents;

    if (
      !this.config.ALLOW_HIGH_VALUE_CALLS &&
      estimatedCostCents !== undefined &&
      estimatedCostCents > Math.round(this.config.HARD_SPEND_CAP_USDC * 100)
    ) {
      throw new SpendingCapError("This request exceeds the hard MVP safety cap.", {
        estimatedCostCents,
        hardCapCents: Math.round(this.config.HARD_SPEND_CAP_USDC * 100)
      });
    }

    if (
      estimatedCostCents !== undefined &&
      typeof balance.usdcBalance === "number" &&
      balance.usdcBalance * 100 < estimatedCostCents
    ) {
      throw new InsufficientBalanceError("Your AgentCash wallet does not have enough balance.", {
        balanceUsdc: balance.usdcBalance,
        estimatedCostCents
      });
    }

    const confirmationCap = this.walletManager.getConfirmationCap(user);
    if (
      !context.confirmed &&
      (
        context.forceConfirmation ||
        (
          confirmationCap !== undefined &&
          estimatedCostCents !== undefined &&
          estimatedCostCents > Math.round(confirmationCap * 100)
        )
      )
    ) {
      const estimatedLine = estimatedCostCents
        ? `This ${skill.name} call is estimated at ${formatUsdCents(estimatedCostCents)}${costMayVary ? " and the final amount may vary." : "."}`
        : `This ${skill.name} call may incur a paid AgentCash charge.`;
      const capLine =
        confirmationCap !== undefined
          ? `Your current per-call cap is ${formatUsdCents(Math.round(confirmationCap * 100))}.`
          : "Natural language requests always require confirmation before payment.";

      return {
        type: "confirmation_required",
        text: [
          estimatedLine,
          capLine,
          "Confirm to continue or cancel to stop."
        ].join("\n"),
        pending: {
          version: 1,
          type: "skill_confirmation",
          token: crypto.randomUUID(),
          skill: skill.name,
          endpoint: skill.endpoint,
          sanitizedSummary,
          encryptedInput: encryptSecret(rawInput, this.config.MASTER_ENCRYPTION_KEY),
          requestHash,
          telegramIdHash,
          estimatedCostCents,
          costMayVary,
          expiresAt: new Date(
            Date.now() + this.config.PENDING_CONFIRMATION_TTL_SECONDS * 1000
          ).toISOString()
        }
      };
    }

    const transaction = this.db.createTransaction({
      userId: user.id,
      walletId: wallet.id,
      telegramChatId: context.telegramChatId,
      telegramMessageId: context.telegramMessageId ?? null,
      telegramIdHash,
      commandName: skill.name,
      skill: skill.name,
      endpoint: skill.endpoint,
      status: "submitted",
      estimatedCostCents: estimatedCostCents ?? null,
      quotedPriceUsdc:
        estimatedCostCents === undefined ? null : Number((estimatedCostCents / 100).toFixed(2)),
      requestHash
    }) as { id: string };

    try {
      const fetchResult = await this.agentcashClient.fetchJson(wallet, skill.endpoint, body);
      const responseHash = hashSensitiveValue(
        JSON.stringify(fetchResult.data),
        this.config.MASTER_ENCRYPTION_KEY
      );
      const rendered = await skill.formatResult(fetchResult, {
        agentcashClient: this.agentcashClient,
        wallet
      });

      this.db.updateTransaction(transaction.id, {
        status: "success",
        actualCostCents: fetchResult.actualCostCents ?? null,
        responseHash,
        txHash: fetchResult.txHash ?? null
      });

      this.logger.info(
        {
          skill: skill.name,
          walletId: wallet.id,
          telegramIdHash,
          requestHash,
          responseHash,
          estimatedCostCents: estimatedCostCents ?? null,
          actualCostCents: fetchResult.actualCostCents ?? null,
          status: "success"
        },
        "skill execution completed"
      );

      return {
        type: "completed",
        ...rendered,
        estimatedCostCents,
        actualCostCents: fetchResult.actualCostCents
      };
    } catch (error) {
      const responseHash =
        error instanceof Error
          ? hashSensitiveValue(error.message, this.config.MASTER_ENCRYPTION_KEY)
          : undefined;

      this.db.updateTransaction(transaction.id, {
        status: "error",
        responseHash,
        errorCode:
          error instanceof Error && "code" in error
            ? String((error as { code?: string }).code ?? "UNKNOWN")
            : "UNKNOWN",
        errorMessage: error instanceof Error ? error.message : "Unknown error"
      });

      this.logger.warn(
        {
          skill: skill.name,
          walletId: wallet.id,
          telegramIdHash,
          requestHash,
          responseHash,
          estimatedCostCents: estimatedCostCents ?? null,
          status: "error"
        },
        "skill execution failed"
      );

      throw error instanceof Error
        ? error
        : new AgentCashError("Skill execution failed", { cause: String(error) });
    }
  }

  decryptPendingInput(pending: PendingConfirmation): string {
    return decryptSecret(pending.encryptedInput, this.config.MASTER_ENCRYPTION_KEY);
  }
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
      if (!object) {
        return null;
      }

      const title = pickFirstString(object, ["title", "name"]);
      const url = pickFirstString(object, ["url", "link"]);
      const snippet = pickFirstString(object, ["snippet", "text", "summary"]);

      if (!title || !url) {
        return null;
      }

      return { title, url, snippet };
    })
    .filter(Boolean) as Array<{ title: string; url: string; snippet?: string }>;
}

function firstObject(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstObject(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return null;
}

function pickFirstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
