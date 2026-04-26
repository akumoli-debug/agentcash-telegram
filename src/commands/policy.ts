import type { Context } from "telegraf";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { isPrivateTelegramChat, getCommandArgument, replyDmInstructionForUserWalletCommand } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";
import { ValidationError } from "../lib/errors.js";

const amountSchema = z.coerce.number().positive();
const skillNames = ["research", "enrich", "generate"] as const;
type SkillName = (typeof skillNames)[number];

export function createPolicyCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
}) {
  return async (ctx: Context) => {
    try {
      if (!isPrivateTelegramChat(ctx)) {
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      if (!ctx.from) {
        return;
      }

      const telegramId = String(ctx.from.id);
      const raw = getCommandArgument(ctx);
      const [subcommand = "show", ...rest] = raw.split(/\s+/).filter(Boolean);

      if (subcommand === "show" || subcommand === "") {
        await handlePolicyShow(ctx, deps, telegramId);
        return;
      }

      if (subcommand === "dailycap") {
        const arg = rest[0] ?? "";
        if (!arg || arg.toLowerCase() === "off") {
          const { user, wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
          void user;
          deps.db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: null });
          await ctx.reply("Daily spend cap removed.");
          return;
        }
        const parsed = amountSchema.safeParse(arg);
        if (!parsed.success) {
          await ctx.reply("Usage: /policy dailycap <amount|off>  e.g. /policy dailycap 5.00");
          return;
        }
        const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
        deps.db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: parsed.data });
        await ctx.reply(`Daily spend cap set to $${parsed.data.toFixed(2)} USDC.`);
        return;
      }

      if (subcommand === "weeklycap") {
        const arg = rest[0] ?? "";
        if (!arg || arg.toLowerCase() === "off") {
          const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
          deps.db.upsertWalletPolicy(wallet.id, { weeklyCapUsdc: null });
          await ctx.reply("Weekly spend cap removed.");
          return;
        }
        const parsed = amountSchema.safeParse(arg);
        if (!parsed.success) {
          await ctx.reply("Usage: /policy weeklycap <amount|off>  e.g. /policy weeklycap 20.00");
          return;
        }
        const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
        deps.db.upsertWalletPolicy(wallet.id, { weeklyCapUsdc: parsed.data });
        await ctx.reply(`Weekly spend cap set to $${parsed.data.toFixed(2)} USDC.`);
        return;
      }

      if (subcommand === "allow-skill") {
        const skill = rest[0]?.toLowerCase() as SkillName | undefined;
        if (!skill || !(skillNames as readonly string[]).includes(skill)) {
          await ctx.reply(`Usage: /policy allow-skill <skill>\nAvailable: ${skillNames.join(", ")}`);
          return;
        }
        const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
        deps.db.upsertSkillPolicy(wallet.id, skill, "allowed");
        await ctx.reply(`Skill '${skill}' is now allowed for your wallet.`);
        return;
      }

      if (subcommand === "block-skill") {
        const skill = rest[0]?.toLowerCase() as SkillName | undefined;
        if (!skill || !(skillNames as readonly string[]).includes(skill)) {
          await ctx.reply(`Usage: /policy block-skill <skill>\nAvailable: ${skillNames.join(", ")}`);
          return;
        }
        const { wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
        deps.db.upsertSkillPolicy(wallet.id, skill, "blocked");
        await ctx.reply(`Skill '${skill}' is now blocked for your wallet.`);
        return;
      }

      if (subcommand === "freeze") {
        deps.walletManager.freezeUserWallet(telegramId);
        await ctx.reply("Your wallet is frozen. Balance, deposit, and history still work.");
        return;
      }

      if (subcommand === "unfreeze") {
        deps.walletManager.unfreezeUserWallet(telegramId);
        await ctx.reply("Your wallet is active again.");
        return;
      }

      await ctx.reply(
        [
          "Wallet policy commands:",
          "  /policy              — show current policy",
          "  /policy dailycap <amount|off>",
          "  /policy weeklycap <amount|off>",
          "  /policy allow-skill <skill>",
          "  /policy block-skill <skill>",
          "  /policy freeze",
          "  /policy unfreeze"
        ].join("\n")
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}

async function handlePolicyShow(
  ctx: Context,
  deps: { config: AppConfig; db: AppDatabase; walletManager: WalletManager },
  telegramId: string
): Promise<void> {
  const { user, wallet } = await deps.walletManager.getOrCreateWalletForTelegramUser(telegramId);
  const walletPolicy = deps.db.getWalletPolicy(wallet.id);
  const confirmationCap = deps.walletManager.getConfirmationCap(user);

  const skillLines: string[] = [];
  for (const skill of ["research", "enrich", "generate"]) {
    const sp = deps.db.getSkillPolicy(wallet.id, skill);
    if (sp && sp.status !== "allowed") {
      skillLines.push(`  ${skill}: ${sp.status}`);
    }
  }

  const dailyCapLine = walletPolicy?.daily_cap_usdc !== null && walletPolicy?.daily_cap_usdc !== undefined
    ? `$${walletPolicy.daily_cap_usdc.toFixed(2)}`
    : deps.config.POLICY_DAILY_CAP_USDC !== undefined
    ? `$${deps.config.POLICY_DAILY_CAP_USDC.toFixed(2)} (global)`
    : "unlimited";

  const weeklyCapLine = walletPolicy?.weekly_cap_usdc !== null && walletPolicy?.weekly_cap_usdc !== undefined
    ? `$${walletPolicy.weekly_cap_usdc.toFixed(2)}`
    : deps.config.POLICY_WEEKLY_CAP_USDC !== undefined
    ? `$${deps.config.POLICY_WEEKLY_CAP_USDC.toFixed(2)} (global)`
    : "unlimited";

  const perCallCapLine = confirmationCap !== undefined
    ? `$${confirmationCap.toFixed(2)} per call (confirmation required above)`
    : "disabled";

  const lines = [
    `Wallet status: ${wallet.status}`,
    `Per-call cap: ${perCallCapLine}`,
    `Daily cap: ${dailyCapLine}`,
    `Weekly cap: ${weeklyCapLine}`,
    ...(skillLines.length > 0 ? [`Skill overrides:`, ...skillLines] : [])
  ];

  await ctx.reply(lines.join("\n"));
}

export function buildPolicyShowText(
  deps: { config: AppConfig; db: AppDatabase; walletManager: WalletManager },
  walletId: string,
  confirmationCapUsdc: number | undefined,
  walletStatus: string
): string {
  const walletPolicy = deps.db.getWalletPolicy(walletId);

  const dailyCapLine = walletPolicy?.daily_cap_usdc !== null && walletPolicy?.daily_cap_usdc !== undefined
    ? `$${walletPolicy.daily_cap_usdc.toFixed(2)}`
    : deps.config.POLICY_DAILY_CAP_USDC !== undefined
    ? `$${deps.config.POLICY_DAILY_CAP_USDC.toFixed(2)} (global)`
    : "unlimited";

  const weeklyCapLine = walletPolicy?.weekly_cap_usdc !== null && walletPolicy?.weekly_cap_usdc !== undefined
    ? `$${walletPolicy.weekly_cap_usdc.toFixed(2)}`
    : deps.config.POLICY_WEEKLY_CAP_USDC !== undefined
    ? `$${deps.config.POLICY_WEEKLY_CAP_USDC.toFixed(2)} (global)`
    : "unlimited";

  const perCallCapLine = confirmationCapUsdc !== undefined
    ? `$${confirmationCapUsdc.toFixed(2)} per call`
    : "disabled";

  return [
    `Wallet status: ${walletStatus}`,
    `Per-call cap: ${perCallCapLine}`,
    `Daily cap: ${dailyCapLine}`,
    `Weekly cap: ${weeklyCapLine}`
  ].join("\n");
}
