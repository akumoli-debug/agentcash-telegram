import type { Context } from "telegraf";
import {
  AgentCashError,
  AppError,
  InsufficientBalanceError,
  NotFoundError,
  QuoteError,
  SpendingCapError,
  TimeoutError,
  ValidationError
} from "../lib/errors.js";

export async function replyWithError(ctx: Context, error: unknown): Promise<void> {
  const message = buildErrorMessage(error);
  await ctx.reply(message);
}

function buildErrorMessage(error: unknown): string {
  if (error instanceof ValidationError) {
    return error.message;
  }

  if (error instanceof NotFoundError) {
    return "Run /start first to initialize your wallet.";
  }

  if (error instanceof InsufficientBalanceError) {
    return "Insufficient balance. Use /deposit to fund your wallet, then try again.";
  }

  if (error instanceof QuoteError) {
    return error.message;
  }

  if (error instanceof SpendingCapError) {
    return error.message;
  }

  if (error instanceof TimeoutError) {
    return "AgentCash timed out. Please try again in a moment.";
  }

  if (error instanceof AgentCashError) {
    return "AgentCash request failed. Please try again shortly.";
  }

  if (error instanceof AppError) {
    return error.message;
  }

  return "Something went wrong while handling that command.";
}
