import type { Context } from "telegraf";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { hashTelegramId } from "../lib/crypto.js";
import { replyWithError } from "./replyWithError.js";
import { ValidationError } from "../lib/errors.js";

function formatHistoryEntry(entry: {
  id: string;
  skill: string | null;
  status: string;
  quoted_price_usdc: number | null;
  actual_cost_cents: number | null;
  created_at: string;
  error_code: string | null;
  is_dev_unquoted: number | null;
}, index: number): string {
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

  return `${index + 1}. ${skill}  ${statusLabel}  ${cost}  ${date}${devTag}${errTag}`;
}

export function createHistoryCommand(deps: {
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

      const telegramIdHash = hashTelegramId(String(from.id), deps.config.MASTER_ENCRYPTION_KEY);
      const entries = deps.db.getHistoryForUser(telegramIdHash, 10);

      if (entries.length === 0) {
        await ctx.reply("No transaction history yet. Try /research, /enrich, or /generate.");
        return;
      }

      const lines = [
        "Your last transactions:",
        "",
        ...entries.map((entry, i) => formatHistoryEntry(entry, i)),
        "",
        "Use /balance to check your current wallet balance."
      ];

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
