import type { Context } from "telegraf";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase, GroupMemberRow, GroupRow, HistoryEntry, UserRow } from "../db/client.js";
import { ValidationError } from "../lib/errors.js";
import {
  assertTelegramGroupAdmin,
  getTelegramMemberStatus,
  isAdminStatus,
  listTelegramGroupAdmins
} from "../telegram/adminVerifier.js";
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

      if (chat.type !== "group" && chat.type !== "supergroup") {
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
        const telegramStatus = await assertTelegramGroupAdmin(ctx, chatId, userId);
        const existingGroup = deps.db.getGroupByTelegramChatHash(
          WalletManager.getHashedChatId(chatId, deps.config.MASTER_ENCRYPTION_KEY)
        );

        if (existingGroup) {
          const existingContext = await deps.walletManager.getGroupWalletForTelegramChat(chatId, userId);
          if (!existingContext?.group) {
            await ctx.reply("No group wallet exists yet. Run /groupwallet create in this group first.");
            return;
          }

          deps.db.recordTelegramAdminVerification({
            groupId: existingContext.group.id,
            userId: existingContext.user.id,
            telegramStatus,
            source: "getChatMember"
          });

          if (await ownerNeedsAdminSync(ctx, deps, chatId, existingContext.group)) {
            await ctx.reply(
              "This group wallet already exists, but its original owner is no longer a Telegram admin. Ask a current Telegram admin to run /groupwallet sync-admins."
            );
            return;
          }

          await ctx.reply(
            [
              "Group wallet already exists.",
              "No owner was changed.",
              "Run /groupwallet sync-admins after Telegram admin changes."
            ].join("\n")
          );
          return;
        }

        const result = await deps.walletManager.getOrCreateGroupWallet({
          chatId,
          title: "title" in chat ? chat.title : null,
          createdByTelegramId: userId
        });

        if (result.group) {
          deps.db.recordTelegramAdminVerification({
            groupId: result.group.id,
            userId: result.user.id,
            telegramStatus,
            source: "getChatMember"
          });
        }

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

      if (subcommand === "members" || subcommand === "roles") {
        const summaries = deps.db.getGroupMemberSummaries(groupContext.group.id);
        const roleCounts = new Map(summaries.map(entry => [entry.role, entry.count]));

        await ctx.reply(
          [
            "Group wallet roles:",
            `Owners: ${roleCounts.get("owner") ?? 0}`,
            `Admins: ${roleCounts.get("admin") ?? 0}`,
            `Members: ${roleCounts.get("member") ?? 0}`,
            "Role model: the original creator is owner; Telegram admins sync to internal admins; other interacting users are members.",
            "Telegram admins control group wallet admin rights. Run /groupwallet sync-admins after admin changes."
          ].join("\n")
        );
        return;
      }

      if (subcommand === "sync-admins") {
        await assertFreshTelegramAdmin(ctx, deps, groupContext.group, groupContext.user, chatId);
        const result = await syncTelegramAdmins(ctx, deps, groupContext.group, chatId);

        await ctx.reply(
          [
            "Group wallet admin sync complete.",
            `Known Telegram admins promoted: ${result.promoted}`,
            `Internal admins demoted: ${result.demoted}`,
            `Known Telegram admins verified: ${result.verified}`,
            `Telegram admins not known to the bot: ${result.unknownAdmins}`
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
          await assertInternalAndFreshTelegramAdmin(ctx, deps, groupContext.group, groupContext.user, chatId);
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

        await assertInternalAndFreshTelegramAdmin(ctx, deps, groupContext.group, groupContext.user, chatId);

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

      if (subcommand === "policy") {
        const walletPolicy = deps.db.getWalletPolicy(groupContext.wallet.id);
        const perCallCap = deps.walletManager.getGroupConfirmationCap(groupContext.group);
        const dailyCapLine =
          walletPolicy?.daily_cap_usdc !== null && walletPolicy?.daily_cap_usdc !== undefined
            ? `$${walletPolicy.daily_cap_usdc.toFixed(2)}`
            : `$${(deps.config.GROUP_DAILY_CAP_USDC ?? 25).toFixed(2)} (global)`;
        const weeklyCapLine =
          walletPolicy?.weekly_cap_usdc !== null && walletPolicy?.weekly_cap_usdc !== undefined
            ? `$${walletPolicy.weekly_cap_usdc.toFixed(2)}`
            : "unlimited";

        await ctx.reply(
          [
            `Group wallet status: ${groupContext.wallet.status}`,
            `Per-call cap: ${perCallCap !== undefined ? `$${perCallCap.toFixed(2)}` : "disabled"}`,
            `Daily cap: ${dailyCapLine}`,
            `Weekly cap: ${weeklyCapLine}`
          ].join("\n")
        );
        return;
      }

      if (subcommand === "dailycap") {
        await assertInternalAndFreshTelegramAdmin(ctx, deps, groupContext.group, groupContext.user, chatId);
        const arg = rest[0] ?? "";
        if (!arg || arg.toLowerCase() === "off") {
          deps.db.upsertWalletPolicy(groupContext.wallet.id, { dailyCapUsdc: null });
          await ctx.reply(`Group daily cap removed. Falling back to global cap: $${(deps.config.GROUP_DAILY_CAP_USDC ?? 25).toFixed(2)}.`);
          return;
        }
        const parsed = amountSchema.safeParse(arg);
        if (!parsed.success) {
          throw new ValidationError("Usage: /groupwallet dailycap <amount|off>");
        }
        deps.db.upsertWalletPolicy(groupContext.wallet.id, { dailyCapUsdc: parsed.data });
        await ctx.reply(`Group daily spend cap set to $${parsed.data.toFixed(2)} USDC.`);
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
      "/groupwallet roles",
      "/groupwallet sync-admins",
      "/groupwallet history",
      "/groupwallet cap <amount>",
      "/groupwallet policy",
      "/groupwallet dailycap <amount|off>",
      "/groupwallet help"
    ].join("\n")
  );
}

async function assertInternalAndFreshTelegramAdmin(
  ctx: Context,
  deps: { db: AppDatabase; walletManager: WalletManager },
  group: GroupRow,
  user: UserRow,
  chatId: string
): Promise<void> {
  if (!deps.walletManager.isGroupAdmin(group.id, user.id)) {
    throw new ValidationError("Only a group wallet owner or admin can change group wallet admin settings.");
  }

  const telegramStatus = await assertTelegramGroupAdmin(ctx, chatId, user.telegram_user_id);
  deps.db.recordTelegramAdminVerification({
    groupId: group.id,
    userId: user.id,
    telegramStatus,
    source: "getChatMember"
  });

  if (!deps.db.hasFreshTelegramAdminVerification(group.id, user.id)) {
    throw new ValidationError("Telegram admin verification is stale. Run /groupwallet sync-admins and try again.");
  }
}

async function assertFreshTelegramAdmin(
  ctx: Context,
  deps: { db: AppDatabase },
  group: GroupRow,
  user: UserRow,
  chatId: string
): Promise<void> {
  const telegramStatus = await assertTelegramGroupAdmin(ctx, chatId, user.telegram_user_id);
  deps.db.recordTelegramAdminVerification({
    groupId: group.id,
    userId: user.id,
    telegramStatus,
    source: "getChatMember"
  });
}

async function ownerNeedsAdminSync(
  ctx: Context,
  deps: { db: AppDatabase },
  chatId: string,
  group: GroupRow
): Promise<boolean> {
  const owner = deps.db.getUserById(group.created_by_user_id);
  if (!owner) {
    return true;
  }

  const status = await getTelegramMemberStatus(ctx, chatId, owner.telegram_user_id);
  return !isAdminStatus(status);
}

async function syncTelegramAdmins(
  ctx: Context,
  deps: { db: AppDatabase },
  group: GroupRow,
  chatId: string
): Promise<{ promoted: number; demoted: number; verified: number; unknownAdmins: number }> {
  const telegramAdmins = await listTelegramGroupAdmins(ctx, chatId);
  const adminTelegramIds = new Set(telegramAdmins.map(admin => admin.userId));
  let promoted = 0;
  let demoted = 0;
  let verified = 0;
  let unknownAdmins = 0;

  for (const admin of telegramAdmins) {
    const user = deps.db.getUserByTelegramId(admin.userId);
    if (!user) {
      unknownAdmins += 1;
      continue;
    }

    deps.db.recordTelegramAdminVerification({
      groupId: group.id,
      userId: user.id,
      telegramStatus: admin.status,
      source: "getChatAdministrators"
    });
    verified += 1;

    const targetRole: GroupMemberRow["role"] =
      user.id === group.created_by_user_id ? "owner" : "admin";
    const result = deps.db.updateGroupMemberRole(group.id, user.id, targetRole);
    if (result.changed && result.previousRole !== "owner") {
      promoted += 1;
      deps.db.createAuditEvent({
        eventName: "group_admin.promoted",
        groupId: group.id,
        actorHash: user.id,
        status: targetRole,
        metadata: { source: "sync-admins" }
      });
    }
  }

  for (const member of deps.db.getGroupMembers(group.id)) {
    if (member.role !== "owner" && member.role !== "admin") {
      continue;
    }

    const user = deps.db.getUserById(member.user_id);
    if (!user) {
      continue;
    }

    if (member.role === "owner" && member.user_id === group.created_by_user_id) {
      const ownerStatus = await getTelegramMemberStatus(ctx, chatId, user.telegram_user_id);
      if (ownerStatus !== "left" && ownerStatus !== "kicked") {
        continue;
      }
    } else if (adminTelegramIds.has(user.telegram_user_id)) {
      continue;
    }

    const result = deps.db.updateGroupMemberRole(group.id, member.user_id, "member");
    if (result.changed) {
      demoted += 1;
      deps.db.createAuditEvent({
        eventName: "group_admin.demoted",
        groupId: group.id,
        actorHash: member.user_id,
        status: "member",
        metadata: { source: "sync-admins" }
      });
    }
  }

  return { promoted, demoted, verified, unknownAdmins };
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
