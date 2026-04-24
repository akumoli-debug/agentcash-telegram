import type { Context } from "telegraf";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { formatUsdAmount, getCommandArgument } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";
import { ValidationError } from "../lib/errors.js";

const amountSchema = z.coerce.number().positive();

export function createCapCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
}) {
  return async (ctx: Context) => {
    try {
      const from = ctx.from;

      if (!from) {
        throw new ValidationError("Could not identify your Telegram account.");
      }

      const user = deps.db.upsertUser({
        telegramUserId: String(from.id),
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        defaultSpendCapUsdc: deps.config.DEFAULT_SPEND_CAP_USDC
      });
      const chatId = String(ctx.chat?.id ?? from.id);
      const rawInput = getCommandArgument(ctx);
      const lower = rawInput.toLowerCase();

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: chatId,
        currentCommand: "cap",
        stateJson: null
      });

      if (!rawInput || lower === "show") {
        await ctx.reply(
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
        deps.walletManager.updateUserCap(String(from.id), {
          enabled: false
        });

        await ctx.reply(
          [
            "Per-call confirmation cap is now off.",
            `Hard safety cap remains ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}.`
          ].join("\n")
        );
        return;
      }

      const parsedAmount = amountSchema.safeParse(rawInput);

      if (!parsedAmount.success) {
        throw new ValidationError("Usage: /cap show, /cap off, or /cap <amount>");
      }

      if (!deps.config.ALLOW_HIGH_VALUE_CALLS && parsedAmount.data > deps.config.HARD_SPEND_CAP_USDC) {
        throw new ValidationError(
          `For MVP, caps above ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)} are disabled.`
        );
      }

      deps.walletManager.updateUserCap(String(from.id), {
        amount: parsedAmount.data,
        enabled: true
      });

      await ctx.reply(
        [
          `Per-call confirmation cap set to ${formatUsdAmount(parsedAmount.data)}.`,
          `Hard safety cap: ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}.`
        ].join("\n")
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
