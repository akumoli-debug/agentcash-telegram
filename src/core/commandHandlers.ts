import { z } from "zod";
import type { SkillExecutor, SkillName } from "../agentcash/skillExecutor.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase, HistoryEntry } from "../db/client.js";
import { ValidationError } from "../lib/errors.js";
import { WalletManager } from "../wallets/walletManager.js";
import type { CommandContext } from "./commandContext.js";

const amountSchema = z.coerce.number().positive();

export interface SharedCommandDeps {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
}

export async function runBalanceCommand(ctx: CommandContext, deps: SharedCommandDeps): Promise<void> {
  assertUserWalletScope(ctx);

  const { user, wallet, balance } = await deps.walletManager.getBalance(
    ctx.walletScope.walletOwnerId,
    ctx.actorProfile
  );

  upsertCoreSession(ctx, deps, user.id, "balance");

  await ctx.replyPrivateOrEphemeral(
    [
      `Wallet address: ${WalletManager.maskAddress(balance.address ?? wallet.address)}`,
      `Balance: ${
        typeof balance.usdcBalance === "number"
          ? `${formatUsdAmount(balance.usdcBalance)} USDC`
          : "unavailable"
      }`,
      `Spend cap: ${
        user.cap_enabled ? `${formatUsdAmount(deps.walletManager.getSpendCap(user))} USDC` : "off"
      }`,
      balance.depositLink ? `Deposit link: ${balance.depositLink}` : "Deposit link: unavailable"
    ].join("\n")
  );
}

export async function runDepositCommand(ctx: CommandContext, deps: SharedCommandDeps): Promise<void> {
  assertUserWalletScope(ctx);

  const { user, deposit } = await deps.walletManager.getDepositAddress(
    ctx.walletScope.walletOwnerId,
    ctx.actorProfile
  );

  upsertCoreSession(ctx, deps, user.id, "deposit");

  await ctx.replyPrivateOrEphemeral(
    [
      `Deposit address: ${deposit.address ?? "unavailable"}`,
      deposit.depositLink ? `Deposit link: ${deposit.depositLink}` : "Deposit link: unavailable"
    ].join("\n")
  );
}

export async function runCapCommand(
  ctx: CommandContext,
  deps: SharedCommandDeps,
  rawInput: string
): Promise<void> {
  assertUserWalletScope(ctx);

  const user = deps.db.upsertUser({
    telegramUserId: ctx.walletScope.walletOwnerId,
    defaultSpendCapUsdc: deps.config.DEFAULT_SPEND_CAP_USDC
  });
  const lower = rawInput.toLowerCase();

  upsertCoreSession(ctx, deps, user.id, "cap");

  if (!rawInput || lower === "show") {
    await ctx.replyPrivateOrEphemeral(
      [
        `Per-call cap: ${user.cap_enabled ? formatUsdAmount(deps.walletManager.getSpendCap(user)) : "off"}`,
        `Default cap: ${formatUsdAmount(deps.config.DEFAULT_SPEND_CAP_USDC)}`,
        `Hard safety cap: ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}`,
        deps.config.ALLOW_HIGH_VALUE_CALLS
          ? "High-value calls are enabled."
          : "Calls above the hard safety cap are blocked."
      ].join("\n")
    );
    return;
  }

  if (lower === "off") {
    deps.walletManager.updateUserCap(ctx.walletScope.walletOwnerId, { enabled: false });

    await ctx.replyPrivateOrEphemeral(
      [
        "Per-call confirmation cap is now off.",
        `Hard safety cap remains ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}.`
      ].join("\n")
    );
    return;
  }

  const parsedAmount = amountSchema.safeParse(rawInput);

  if (!parsedAmount.success) {
    throw new ValidationError("Usage: cap show, cap off, or cap <amount>");
  }

  if (!deps.config.ALLOW_HIGH_VALUE_CALLS && parsedAmount.data > deps.config.HARD_SPEND_CAP_USDC) {
    throw new ValidationError(
      `For MVP, caps above ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)} are disabled.`
    );
  }

  deps.walletManager.updateUserCap(ctx.walletScope.walletOwnerId, {
    amount: parsedAmount.data,
    enabled: true
  });

  await ctx.replyPrivateOrEphemeral(
    [
      `Per-call confirmation cap set to ${formatUsdAmount(parsedAmount.data)}.`,
      `Hard safety cap: ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}.`
    ].join("\n")
  );
}

export async function runHistoryCommand(ctx: CommandContext, deps: SharedCommandDeps): Promise<void> {
  assertUserWalletScope(ctx);

  const entries = deps.db.getHistoryForUser(ctx.actorIdHash, 10);

  if (entries.length === 0) {
    await ctx.replyPrivateOrEphemeral("No transaction history yet. Try research, enrich, or generate.");
    return;
  }

  await ctx.replyPrivateOrEphemeral(
    [
      "Your last transactions:",
      "",
      ...entries.map((entry, i) => formatHistoryEntry(entry, i)),
      "",
      "Use balance to check your current wallet balance."
    ].join("\n")
  );
}

export async function runSkillCommand(
  ctx: CommandContext,
  deps: SharedCommandDeps,
  skillName: SkillName,
  rawInput: string,
  options?: { forceConfirmation?: boolean }
): Promise<void> {
  assertUserWalletScope(ctx);

  const user = deps.db.upsertUser({
    telegramUserId: ctx.walletScope.walletOwnerId,
    defaultSpendCapUsdc: deps.config.DEFAULT_SPEND_CAP_USDC
  });

  upsertCoreSession(ctx, deps, user.id, skillName);

  const result = await deps.skillExecutor.execute(skillName, rawInput, {
    telegramId: ctx.walletScope.walletOwnerId,
    telegramProfile: ctx.actorProfile,
    telegramChatId: ctx.walletScope.chatId,
    telegramChatType: ctx.walletScope.chatType,
    telegramMessageId: ctx.messageId ?? null,
    forceConfirmation: options?.forceConfirmation
  });

  if (result.type === "confirmation_required") {
    deps.db.upsertSession({
      userId: user.id,
      telegramChatId: ctx.walletScope.chatId,
      currentCommand: skillName,
      stateJson: JSON.stringify({ type: "quote_confirmation", quote_id: result.quoteId })
    });

    await ctx.confirm({
      text: result.text,
      quoteId: result.quoteId,
      skill: result.skill
    });
    return;
  }

  deps.db.clearSessionState(user.id, ctx.walletScope.chatId);
  await ctx.reply(result.text);
}

export function ensureSupportedWalletScope(ctx: CommandContext): void {
  void ctx;
}

function assertUserWalletScope(ctx: CommandContext): void {
  ensureSupportedWalletScope(ctx);
}

function upsertCoreSession(
  ctx: CommandContext,
  deps: Pick<SharedCommandDeps, "db">,
  userId: string,
  currentCommand: string
) {
  deps.db.upsertSession({
    userId,
    telegramChatId: ctx.walletScope.chatId,
    currentCommand,
    stateJson: null
  });
}

function formatUsdAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatHistoryEntry(entry: HistoryEntry, index: number): string {
  const skill = entry.skill ?? "unknown";
  const status = entry.status;
  const date = new Date(entry.created_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  let cost = "---";
  if (entry.actual_cost_cents !== null) {
    cost = `$${(entry.actual_cost_cents / 100).toFixed(4)}`;
  } else if (entry.quoted_price_usdc !== null) {
    cost = `~$${entry.quoted_price_usdc.toFixed(4)}`;
  }

  const devTag = entry.is_dev_unquoted ? " [dev]" : "";
  const errTag = entry.error_code ? ` (${entry.error_code})` : "";
  const statusLabel = status === "success" ? "✓" : status === "error" ? "✗" : status;
  const requestHash = entry.request_hash ? `  req:${entry.request_hash.slice(0, 12)}` : "";

  return `${index + 1}. ${skill}  ${statusLabel}  ${cost}  ${date}${requestHash}${devTag}${errTag}`;
}
