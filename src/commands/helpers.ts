import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { z } from "zod";
import type { SkillExecutionContext } from "../agentcash/skillExecutor.js";
import type { AppDatabase, SessionRow, UserRow } from "../db/client.js";
import { AppError, ValidationError } from "../lib/errors.js";
import type { TelegramProfile } from "../wallets/walletManager.js";

const sessionQuoteStateSchema = z.object({
  type: z.literal("quote_confirmation"),
  quote_id: z.string().min(1)
});

export type SessionQuoteState = z.infer<typeof sessionQuoteStateSchema>;

export function getCommandArgument(ctx: Context): string {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(" ");

  if (firstSpace === -1) {
    return "";
  }

  return trimmed.slice(firstSpace + 1).trim();
}

export function getTelegramProfile(ctx: Context): TelegramProfile {
  return {
    username: ctx.from?.username ?? null,
    firstName: ctx.from?.first_name ?? null,
    lastName: ctx.from?.last_name ?? null
  };
}

export function getExecutionContext(ctx: Context): SkillExecutionContext {
  const telegramId = String(ctx.from?.id ?? "");

  if (!telegramId) {
    throw new ValidationError("Could not identify your Telegram account.");
  }

  return {
    telegramId,
    telegramProfile: getTelegramProfile(ctx),
    telegramChatId: String(ctx.chat?.id ?? ctx.from?.id ?? ""),
    telegramMessageId:
      ctx.message && "message_id" in ctx.message ? String(ctx.message.message_id) : null
  };
}

export function ensureUserRecord(db: AppDatabase, ctx: Context, defaultSpendCapUsdc: number): UserRow {
  const from = ctx.from;

  if (!from) {
    throw new ValidationError("Could not identify your Telegram account.");
  }

  return db.upsertUser({
    telegramUserId: String(from.id),
    defaultSpendCapUsdc
  });
}

export function parseSessionQuoteState(session?: SessionRow): SessionQuoteState | null {
  if (!session?.state_json) {
    return null;
  }

  try {
    const parsed = sessionQuoteStateSchema.safeParse(JSON.parse(session.state_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function confirmationKeyboard(quoteId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Confirm", `confirm:${quoteId}`),
      Markup.button.callback("Cancel", `cancel:${quoteId}`)
    ]
  ]);
}

export async function replyWithSkillResult(
  ctx: Context,
  result: { text: string; imageUrl?: string }
): Promise<void> {
  if (result.imageUrl) {
    await ctx.replyWithPhoto(result.imageUrl, { caption: result.text });
    return;
  }

  await ctx.reply(result.text);
}

export function formatUsdAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function assertPrivateChatContext(ctx: Context): { telegramId: string; chatId: string } {
  const telegramId = String(ctx.from?.id ?? "");
  const chatId = String(ctx.chat?.id ?? "");

  if (!telegramId || !chatId) {
    throw new ValidationError("Could not identify this Telegram conversation.");
  }

  return { telegramId, chatId };
}

export function getCallbackData(ctx: Context): string {
  const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";

  if (!data) {
    throw new ValidationError("Missing callback data.");
  }

  return data;
}

export function errorMessageForReply(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  return "Something went wrong while handling that command.";
}
