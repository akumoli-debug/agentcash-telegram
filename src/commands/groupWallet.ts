import type { Context } from "telegraf";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase, HistoryEntry } from "../db/client.js";
import { ValidationError } from "../lib/errors.js";
import { WalletManager } from "../wallets/walletManager.js";
import { formatUsdAmount, getCommandArgument } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

const amountSchema = z.coerce.number().positive();

export function createGroupWalletCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
}) {
  return async (ctx: Context) => {
    try {
      const from = ctx.from;
      const chat = ctx.chat;

      if (!from || !chat) {
        throw new ValidationError("Could not identify this Telegram conversation.");
      }

      if (chat.type === "private") {
        await ctx.reply("Group wallet commands must be run inside a Telegram group.");
        return;
      }

      const raw = getCommandArgument(ctx);
      const [subcommand = "help", ...rest] = raw.split(/\s+/).filter(Boolean);
      const chatId = String(chat.id);
      const userId = String(from.id);

      if (subcommand === "help") {
        await replyWithGroupWalletHelp(ctx);
        return;
      }

      if (subcommand === "create") {
        const result = await deps.walletManager.getOrCreateGroupWallet({
          chatId,
          title: "title" in chat ? chat.title : null,
          createdByTelegramId: userId
        });

        deps.db.upsertSession({
          userId: result.user.id,
          telegramChatId: chatId,
          currentCommand: "groupwallet",
          stateJson: null
        });

        await ctx.reply(
          [
            "Group wallet is ready.",
            `Wallet address: ${WalletManager.maskAddress(result.wallet.address)}`,
            `Group cap: ${formatUsdAmount(result.group?.spend_cap_usdc ?? deps.config.DEFAULT_SPEND_CAP_USDC)}`
          ].join("\n")
        );
        return;
      }

      const groupContext = await deps.walletManager.getGroupWalletForTelegramChat(chatId, userId);
      if (!groupContext?.group) {
        await ctx.reply("No group wallet exists yet. Run /groupwallet create in this group first.");
        return;
      }

      deps.db.upsertSession({
        userId: groupContext.user.id,
        telegramChatId: chatId,
        currentCommand: "groupwallet",
        stateJson: null
      });

      if (subcommand === "balance") {
        const { wallet, group, balance } = await deps.walletManager.getGroupBalance(chatId, userId);
        await ctx.reply(
          [
            `Group wallet address: ${WalletManager.maskAddress(balance.address ?? wallet.address)}`,
            `Balance: ${
              typeof balance.usdcBalance === "number"
                ? `${formatUsdAmount(balance.usdcBalance)} USDC`
                : "unavailable"
            }`,
            `Group cap: ${
              group?.cap_enabled
                ? `${formatUsdAmount(group.spend_cap_usdc)} USDC`
                : "off; owner/admin approval required for confirmations only"
            }`,
            balance.depositLink ? `Deposit link: ${balance.depositLink}` : "Deposit link: unavailable"
          ].join("\n")
        );
        return;
      }

      if (subcommand === "deposit") {
        const { deposit } = await deps.walletManager.getGroupDepositAddress(chatId, userId);
        const qrDataUrl = await deps.walletManager.getDepositQrDataUrl(deposit.address ?? "");
        const base64 = qrDataUrl.split(",")[1];

        await ctx.replyWithPhoto(
          { source: Buffer.from(base64 ?? "", "base64") },
          {
            caption: [
              `Group deposit address: ${deposit.address ?? "unavailable"}`,
              deposit.depositLink ? `Deposit link: ${deposit.depositLink}` : "Deposit link: unavailable"
            ].join("\n")
          }
        );
        return;
      }

      if (subcommand === "members") {
        const summaries = deps.db.getGroupMemberSummaries(groupContext.group.id);
        const roleCounts = new Map(summaries.map(entry => [entry.role, entry.count]));

        await ctx.reply(
          [
            "Group wallet members:",
            `Owners: ${roleCounts.get("owner") ?? 0}`,
            `Admins: ${roleCounts.get("admin") ?? 0}`,
            `Members: ${roleCounts.get("member") ?? 0}`,
            "Members are added when they interact with the group wallet."
          ].join("\n")
        );
        return;
      }

      if (subcommand === "history") {
        const entries = deps.db.getHistoryForGroup(groupContext.group.id, 10);
        if (entries.length === 0) {
          await ctx.reply("No group wallet transaction history yet.");
          return;
        }

        await ctx.reply(["Group wallet transactions:", "", ...entries.map(formatHistoryEntry)].join("\n"));
        return;
      }

      if (subcommand === "cap") {
        if (!deps.walletManager.isGroupAdmin(groupContext.group.id, groupContext.user.id)) {
          throw new ValidationError("Only a group wallet owner or admin can change the group cap.");
        }

        const rawAmount = rest.join(" ").trim();
        if (!rawAmount || rawAmount.toLowerCase() === "show") {
          await ctx.reply(
            `Group cap: ${
              groupContext.group.cap_enabled ? formatUsdAmount(groupContext.group.spend_cap_usdc) : "off"
            }`
          );
          return;
        }

        if (rawAmount.toLowerCase() === "off") {
          deps.walletManager.updateGroupCap(groupContext.group.id, { enabled: false });
          await ctx.reply(
            [
              "Group cap is now off.",
              "Over-cap approval no longer triggers from the group cap, but the hard safety cap still applies."
            ].join("\n")
          );
          return;
        }

        const parsed = amountSchema.safeParse(rawAmount);
        if (!parsed.success) {
          throw new ValidationError("Usage: /groupwallet cap show, /groupwallet cap off, or /groupwallet cap <amount>");
        }

        if (!deps.config.ALLOW_HIGH_VALUE_CALLS && parsed.data > deps.config.HARD_SPEND_CAP_USDC) {
          throw new ValidationError(
            `For MVP, caps above ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)} are disabled.`
          );
        }

        deps.walletManager.updateGroupCap(groupContext.group.id, {
          amount: parsed.data,
          enabled: true
        });

        await ctx.reply(
          [
            `Group per-call cap set to ${formatUsdAmount(parsed.data)}.`,
            `Hard safety cap: ${formatUsdAmount(deps.config.HARD_SPEND_CAP_USDC)}.`
          ].join("\n")
        );
        return;
      }

      await replyWithGroupWalletHelp(ctx);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}

async function replyWithGroupWalletHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "Group wallet commands:",
      "/groupwallet create",
      "/groupwallet deposit",
      "/groupwallet balance",
      "/groupwallet members",
      "/groupwallet history",
      "/groupwallet cap <amount>",
      "/groupwallet help"
    ].join("\n")
  );
}

function formatHistoryEntry(entry: HistoryEntry, index: number): string {
  const skill = entry.skill ?? "unknown";
  const date = new Date(entry.created_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const cost =
    entry.actual_cost_cents !== null
      ? `$${(entry.actual_cost_cents / 100).toFixed(4)}`
      : entry.quoted_price_usdc !== null
      ? `~$${entry.quoted_price_usdc.toFixed(4)}`
      : "---";

  return `${index + 1}. ${skill}  ${entry.status}  ${cost}  ${date}`;
}
