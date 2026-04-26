import type { Context } from "telegraf";
import type { AppDatabase } from "../db/client.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { SpendAnalyticsService } from "../analytics/SpendAnalyticsService.js";
import { getCommandArgument, isPrivateTelegramChat, replyDmInstructionForUserWalletCommand } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export function createSpendCommand(deps: { db: AppDatabase; walletManager: WalletManager }) {
  const analytics = new SpendAnalyticsService(deps.db);

  return async (ctx: Context) => {
    try {
      if (!isPrivateTelegramChat(ctx)) {
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      if (!ctx.from) return;
      const telegramId = String(ctx.from.id);

      const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);

      const raw = getCommandArgument(ctx);
      const [subcommand = "overview", ...rest] = raw.split(/\s+/).filter(Boolean);
      void rest;

      if (subcommand === "today") {
        const summary = analytics.getWalletSummary(wallet.id, 1);
        const lines = [
          "Today's spend",
          `Today: ${fmt(summary.totalCentsToday)}`
        ];
        if (summary.bySkill.length > 0) {
          lines.push("", "By skill:");
          for (const row of summary.bySkill) {
            lines.push(`  ${row.skill.padEnd(10)} ${fmt(row.cents).padStart(10)}  ${row.count} call${row.count === 1 ? "" : "s"}`);
          }
        }
        await ctx.reply(lines.join("\n"));
        return;
      }

      if (subcommand === "week") {
        const summary = analytics.getWalletSummary(wallet.id, 7);
        const lines = [
          "Spend last 7 days",
          `Today:          ${fmt(summary.totalCentsToday)}`,
          `Last 7 days:    ${fmt(summary.totalCentsLast7Days)}`
        ];
        if (summary.bySkill.length > 0) {
          lines.push("", "By skill:");
          for (const row of summary.bySkill) {
            lines.push(`  ${row.skill.padEnd(10)} ${fmt(row.cents).padStart(10)}  ${row.count} call${row.count === 1 ? "" : "s"}`);
          }
        }
        await ctx.reply(lines.join("\n"));
        return;
      }

      if (subcommand === "skills") {
        const summary = analytics.getWalletSummary(wallet.id, 30);
        await ctx.reply(analytics.formatSkillsText(summary, "Spend by skill"));
        return;
      }

      if (subcommand === "export") {
        const rows = analytics.getWalletExportRows(wallet.id, 30);
        const csv = analytics.formatExportCsv(rows);
        if (csv.length > 3800) {
          await ctx.reply(
            `Last 30 days — ${rows.length} rows\n\n` +
            `<pre>${csv.slice(0, 3700)}\n…(truncated, use the export script for full data)</pre>`,
            { parse_mode: "HTML" }
          );
        } else {
          await ctx.reply(
            `Last 30 days — ${rows.length} rows\n\n<pre>${csv}</pre>`,
            { parse_mode: "HTML" }
          );
        }
        return;
      }

      // Default: overview
      const summary = analytics.getWalletSummary(wallet.id, 30);
      await ctx.reply(analytics.formatWalletSummaryText(summary, "Spend overview"));
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}
