import type { Context } from "telegraf";
import { AppDatabase } from "../db/client.js";
import { WalletManager } from "../wallets/walletManager.js";
import type { AppConfig } from "../config.js";
import type { SkillExecutor } from "../agentcash/skillExecutor.js";
import { consumeSignedInlinePayload, isInlineStartPayload } from "../lib/inlinePayload.js";
import { getCommandArgument, getExecutionContext } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";
import { executeSkillRequest } from "./skillCommand.js";

export function createStartCommand(deps: {
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
  config: AppConfig;
}) {
  return async (ctx: Context) => {
    try {
      const startPayload = getCommandArgument(ctx);
      if (isInlineStartPayload(startPayload)) {
        const inlinePayload = consumeSignedInlinePayload(
          deps.db,
          deps.config.MASTER_ENCRYPTION_KEY,
          startPayload
        );

        await executeSkillRequest(
          ctx,
          {
            config: deps.config,
            db: deps.db,
            walletManager: deps.walletManager,
            skillExecutor: deps.skillExecutor,
            skillName: inlinePayload.skill
          },
          inlinePayload.input,
          { forceConfirmation: true }
        );
        return;
      }

      const executionContext = getExecutionContext(ctx);
      const { user, deposit } = await deps.walletManager.getDepositAddress(
        executionContext.telegramId,
        executionContext.telegramProfile
      );

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: executionContext.telegramChatId,
        currentCommand: "start",
        stateJson: null
      });

      await ctx.reply(
        [
          "Welcome to AgentCash Telegram.",
          "Your wallet is ready for this Telegram account only.",
          `Deposit address: ${deposit.address ?? "unavailable"}`,
          deposit.depositLink ? `Deposit link: ${deposit.depositLink}` : "Deposit link: unavailable",
          "",
          "Try /balance, /deposit, /research, /enrich, /generate, or /cap show."
        ].join("\n")
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
