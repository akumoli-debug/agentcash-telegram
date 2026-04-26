import type { Context } from "telegraf";
import type { SkillExecutor } from "../agentcash/skillExecutor.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import { runDepositCommand } from "../core/commandHandlers.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { createTelegramCommandContext, replyDmInstructionForUserWalletCommand, isPrivateTelegramChat } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export function createDepositCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
}) {
  return async (ctx: Context) => {
    try {
      if (!isPrivateTelegramChat(ctx)) {
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      await runDepositCommand(createTelegramCommandContext(ctx, deps.config), deps);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
