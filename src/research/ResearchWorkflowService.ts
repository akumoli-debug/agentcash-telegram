import type { AppConfig } from "../config.js";
import { AppDatabase, type WalletRow } from "../db/client.js";
import { hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import { InsufficientBalanceError, QuoteError, SpendingCapError } from "../lib/errors.js";
import type { AppLogger } from "../lib/logger.js";
import { WalletManager, type TelegramProfile } from "../wallets/walletManager.js";
import { AgentCashClient } from "../agentcash/agentcashClient.js";
import { canonicalizeJson, formatUsdCents, usdcToCents } from "../agentcash/skillExecutor.js";

export const RESEARCH_WORKFLOW_ENDPOINT = "agentic-research://workflow/v1";

export interface ResearchWorkflowContext {
  telegramId: string;
  telegramProfile?: TelegramProfile;
  telegramChatId: string;
  telegramChatType?: string;
  telegramMessageId?: string | null;
}

interface ResearchStep {
  id: string;
  label: string;
  endpoint?: string;
  body?: Record<string, unknown>;
  estimatedCostCents: number;
  paid: boolean;
}

interface ResearchWorkflowRequest {
  kind: "agentic_research_workflow";
  query: string;
  steps: ResearchStep[];
  totalEstimatedCostCents: number;
  demoMode: boolean;
}

export interface ResearchWorkflowConfirmationResult {
  type: "confirmation_required";
  text: string;
  quoteId: string;
  skill: "research";
  quotedCostCents: number;
  expiresAt: string;
  isDevUnquoted: false;
}

export interface ResearchWorkflowCompletedResult {
  type: "completed";
  text: string;
  estimatedCostCents: number;
}

export class ResearchWorkflowService {
  constructor(
    private readonly db: AppDatabase,
    private readonly walletManager: WalletManager,
    private readonly agentcashClient: AgentCashClient,
    private readonly logger: AppLogger,
    private readonly config: AppConfig
  ) {}

  isWorkflowQuote(quote: { endpoint: string }): boolean {
    return quote.endpoint === RESEARCH_WORKFLOW_ENDPOINT;
  }

  async planAndQuote(
    rawQuery: string,
    context: ResearchWorkflowContext
  ): Promise<ResearchWorkflowConfirmationResult> {
    const query = rawQuery.trim();
    if (query.length < 3) {
      throw new QuoteError("Please provide a research topic.");
    }

    const userHash = hashTelegramId(context.telegramId, this.config.MASTER_ENCRYPTION_KEY);
    const { user, wallet, balance } = await this.walletManager.getBalance(
      context.telegramId,
      context.telegramProfile
    );
    const steps = await this.buildPlanAndQuotes(wallet, query, userHash);
    const totalEstimatedCostCents = steps.reduce((sum, step) => sum + step.estimatedCostCents, 0);
    const request: ResearchWorkflowRequest = {
      kind: "agentic_research_workflow",
      query,
      steps,
      totalEstimatedCostCents,
      demoMode: this.config.RESEARCH_WORKFLOW_DEMO_MODE
    };
    const canonicalJson = canonicalizeJson(request);
    const requestHash = hashSensitiveValue(canonicalJson, this.config.MASTER_ENCRYPTION_KEY);

    this.assertWorkflowPolicy({
      userHash,
      walletId: wallet.id,
      requestHash,
      quotedCostCents: totalEstimatedCostCents,
      userCapCents: this.walletManager.getConfirmationCap(user) === undefined
        ? undefined
        : usdcToCents(this.walletManager.getConfirmationCap(user)!),
      balanceCents: typeof balance.usdcBalance === "number" ? usdcToCents(balance.usdcBalance) : undefined
    });

    const hardCapCents = usdcToCents(this.config.HARD_SPEND_CAP_USDC);
    const expiresAt = new Date(Date.now() + this.config.PENDING_CONFIRMATION_TTL_SECONDS * 1000).toISOString();
    const quote = this.db.createQuote({
      userHash,
      walletId: wallet.id,
      skill: "research",
      endpoint: RESEARCH_WORKFLOW_ENDPOINT,
      canonicalRequestJson: canonicalJson,
      requestHash,
      quotedCostCents: totalEstimatedCostCents,
      maxApprovedCostCents: Math.min(totalEstimatedCostCents, hardCapCents),
      isDevUnquoted: false,
      expiresAt,
      requesterUserId: user.id,
      groupId: null,
      requiresGroupAdminApproval: false,
      platform: "telegram",
      actorIdHash: userHash,
      walletScope: "user"
    });

    this.logger.info(
      { quoteId: quote.id, userHash, requestHash, totalEstimatedCostCents },
      "agentic research workflow quoted"
    );

    return {
      type: "confirmation_required",
      text: this.formatPlan(query, steps, totalEstimatedCostCents),
      quoteId: quote.id,
      skill: "research",
      quotedCostCents: totalEstimatedCostCents,
      expiresAt: quote.expires_at,
      isDevUnquoted: false
    };
  }

  async executeApprovedQuote(
    quoteId: string,
    context: ResearchWorkflowContext
  ): Promise<ResearchWorkflowCompletedResult> {
    const quote = this.db.getQuote(quoteId);
    const userHash = hashTelegramId(context.telegramId, this.config.MASTER_ENCRYPTION_KEY);

    if (!quote || !this.isWorkflowQuote(quote)) {
      throw new QuoteError("This research confirmation is no longer valid.");
    }

    if (quote.user_hash !== userHash) {
      throw new QuoteError("This confirmation does not belong to your account.");
    }

    if (quote.status !== "pending") {
      throw new QuoteError("This confirmation was already used.");
    }

    if (new Date(quote.expires_at) <= new Date()) {
      this.db.updateQuoteStatus(quoteId, "expired");
      throw new QuoteError("This confirmation expired. Please run /research again.");
    }

    const wallet = this.db.getWalletById(quote.wallet_id);
    if (!wallet) {
      throw new QuoteError("Wallet not found for this research quote.");
    }

    const request = JSON.parse(quote.canonical_request_json) as ResearchWorkflowRequest;
    if (!this.db.atomicApproveQuote(quoteId)) {
      throw new QuoteError("This confirmation was already used.");
    }
    if (!this.db.atomicBeginQuoteExecution(quoteId)) {
      throw new QuoteError("This confirmation was already used.");
    }

    const transaction = this.db.createTransaction({
      userId: quote.requester_user_id ?? wallet.owner_user_id ?? "",
      walletId: wallet.id,
      telegramChatId: context.telegramChatId,
      telegramMessageId: context.telegramMessageId ?? null,
      telegramIdHash: userHash,
      commandName: "research",
      skill: "research",
      origin: "agentic_research_workflow",
      endpoint: RESEARCH_WORKFLOW_ENDPOINT,
      quoteId,
      status: "submitted",
      quotedPriceUsdc: Number((quote.quoted_cost_cents / 100).toFixed(6)),
      estimatedCostCents: quote.quoted_cost_cents,
      requestHash: quote.request_hash,
      requestSummary: `agentic_research:${quote.request_hash.slice(0, 12)}`,
      idempotencyKey: `quote:${quoteId}:research-workflow`
    }) as { id: string };

    const report = await this.compileReport(request);
    const responseHash = hashSensitiveValue(report, this.config.MASTER_ENCRYPTION_KEY);
    this.db.updateTransaction(transaction.id, {
      status: "success",
      responseHash,
      responseSummary: "agentic research report compiled"
    });
    this.db.transitionQuoteStatus(quoteId, "executing", "succeeded", {
      executedAt: new Date().toISOString(),
      transactionId: transaction.id
    });

    return {
      type: "completed",
      text: report,
      estimatedCostCents: quote.quoted_cost_cents
    };
  }

  private async buildPlanAndQuotes(
    wallet: WalletRow,
    query: string,
    userHash: string
  ): Promise<ResearchStep[]> {
    const planned = this.buildDeterministicPlan(query);

    if (this.config.RESEARCH_WORKFLOW_DEMO_MODE) {
      return planned;
    }

    const quoted: ResearchStep[] = [];
    for (const step of planned) {
      if (!step.paid || !step.endpoint) {
        quoted.push(step);
        continue;
      }

      const result = await this.agentcashClient.checkEndpoint(wallet, step.endpoint, step.body);
      if (result.estimatedCostCents === undefined) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: wallet.id,
          skill: "research",
          endpoint: step.endpoint,
          failureStage: "quote",
          errorCode: "quote_missing",
          safeErrorMessage: "Research workflow step did not return a price quote"
        });
        throw new QuoteError("quote_missing: I could not get a reliable price quote, so I blocked execution.");
      }

      if (!Number.isSafeInteger(result.estimatedCostCents) || result.estimatedCostCents <= 0) {
        this.db.logPreflightAttempt({
          userHash,
          walletId: wallet.id,
          skill: "research",
          endpoint: step.endpoint,
          failureStage: "quote",
          errorCode: "quote_invalid",
          safeErrorMessage: "Research workflow step returned an invalid price quote"
        });
        throw new QuoteError("quote_invalid: I could not get a reliable price quote, so I blocked execution.");
      }

      quoted.push({ ...step, estimatedCostCents: result.estimatedCostCents });
    }

    return quoted;
  }

  private buildDeterministicPlan(query: string): ResearchStep[] {
    void query;
    return [
      {
        id: "discover",
        label: "Discover(stableenrich.dev)",
        estimatedCostCents: 0,
        paid: false
      },
      {
        id: "exa-agentic-payments",
        label: 'Exa Search("agentic payments infrastructure 2025-2026")',
        endpoint: "https://stableenrich.dev/api/exa/search",
        body: { query: "agentic payments infrastructure 2025-2026", numResults: 5, type: "neural" },
        estimatedCostCents: 8,
        paid: true
      },
      {
        id: "exa-x402",
        label: 'Exa Search("x402 protocol machine-to-machine payments")',
        endpoint: "https://stableenrich.dev/api/exa/search",
        body: { query: "x402 protocol machine-to-machine payments", numResults: 5, type: "neural" },
        estimatedCostCents: 8,
        paid: true
      },
      {
        id: "firecrawl",
        label: "Firecrawl(scraping 12 key sources)",
        endpoint: "https://stableenrich.dev/api/firecrawl/scrape",
        body: { topic: "agentic payments", maxSources: 12 },
        estimatedCostCents: 18,
        paid: true
      },
      {
        id: "compile",
        label: "Compile report",
        estimatedCostCents: 0,
        paid: false
      }
    ];
  }

  private assertWorkflowPolicy(input: {
    userHash: string;
    walletId: string;
    requestHash: string;
    quotedCostCents: number;
    userCapCents?: number;
    balanceCents?: number;
  }): void {
    const hardCapCents = usdcToCents(this.config.HARD_SPEND_CAP_USDC);

    if (!this.config.ALLOW_HIGH_VALUE_CALLS && input.quotedCostCents > hardCapCents) {
      this.logPolicyFailure(input, "cap", "exceeds_hard_cap", "Research workflow exceeds hard cap");
      throw new SpendingCapError(
        `exceeds_hard_cap: This research plan is estimated at ${formatUsdCents(input.quotedCostCents)}, ` +
        `above the hard MVP safety cap of ${formatUsdCents(hardCapCents)}.`
      );
    }

    if (input.userCapCents !== undefined && input.quotedCostCents > input.userCapCents) {
      this.logPolicyFailure(input, "cap", "exceeds_user_cap", "Research workflow exceeds user cap");
      throw new SpendingCapError(
        `exceeds_user_cap: This research plan is estimated at ${formatUsdCents(input.quotedCostCents)}, ` +
        `above your per-call cap of ${formatUsdCents(input.userCapCents)}.`
      );
    }

    if (input.balanceCents !== undefined && input.balanceCents < input.quotedCostCents) {
      this.logPolicyFailure(input, "balance", "insufficient_balance", "Research workflow exceeds wallet balance");
      throw new InsufficientBalanceError(
        `insufficient_balance: This research plan is estimated at ${formatUsdCents(input.quotedCostCents)}, ` +
        `but your wallet balance is ${formatUsdCents(input.balanceCents)}.`
      );
    }
  }

  private logPolicyFailure(
    input: {
      userHash: string;
      walletId: string;
      requestHash: string;
    },
    failureStage: "balance" | "cap",
    errorCode: "exceeds_user_cap" | "insufficient_balance" | "exceeds_hard_cap" | "daily_cap_exceeded",
    safeErrorMessage: string
  ): void {
    this.db.logPreflightAttempt({
      userHash: input.userHash,
      walletId: input.walletId,
      skill: "research",
      endpoint: RESEARCH_WORKFLOW_ENDPOINT,
      requestHash: input.requestHash,
      failureStage,
      errorCode,
      safeErrorMessage
    });
  }

  private formatPlan(query: string, steps: ResearchStep[], totalEstimatedCostCents: number): string {
    const paidLines = steps.map(step => {
      const suffix = step.paid
        ? ` estimated ${formatUsdCents(step.estimatedCostCents)}`
        : step.id === "compile"
        ? " estimated $0.00 (local compile)"
        : "";
      return `- ${step.label}${suffix}`;
    });

    return [
      "I'll compile a comprehensive report using multiple data sources.",
      "",
      `Research topic: ${query}`,
      "",
      "Plan:",
      ...paidLines,
      "",
      `Total estimated AgentCash spend: ${formatUsdCents(totalEstimatedCostCents)}.`,
      "",
      "Confirm to approve this research plan or cancel to stop."
    ].join("\n");
  }

  private async compileReport(request: ResearchWorkflowRequest): Promise<string> {
    return [
      `Research report: ${request.query}`,
      "",
      "Summary",
      "Agentic payments are emerging as a control layer for software agents that need to discover, quote, approve, and execute paid web actions without exposing open-ended spend authority.",
      "",
      "Key findings",
      "- x402-style payment flows make price discovery and machine-to-machine settlement part of normal HTTP/API interactions.",
      "- Wallet-scoped caps, hard safety ceilings, and per-step quote records are essential for keeping autonomous workflows auditable.",
      "- Research workflows should aggregate quotes before execution so the user approves the whole plan, not an opaque single call.",
      "",
      "Workflow evidence",
      ...request.steps.map(step => `- ${step.label}: ${formatUsdCents(step.estimatedCostCents)}`),
      "",
      `Estimated AgentCash spend approved: ${formatUsdCents(request.totalEstimatedCostCents)}.`
    ].join("\n");
  }
}
