import type { Context } from "telegraf";
import { type SkillExecutor, type SkillName } from "../agentcash/skillExecutor.js";
import type { AppConfig } from "../config.js";
import { runSkillCommand } from "../core/commandHandlers.js";
import type { AppDatabase } from "../db/client.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { createTelegramCommandContext, getCommandArgument } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export interface SkillCommandDeps {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
  skillName: SkillName;
}

export function createSkillCommand(deps: SkillCommandDeps) {
  return async (ctx: Context) => {
    try {
      await executeSkillRequest(ctx, deps, getCommandArgument(ctx));
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}

export async function executeSkillRequest(
  ctx: Context,
  deps: SkillCommandDeps,
  rawInput: string,
  options?: { forceConfirmation?: boolean }
): Promise<void> {
  await runSkillCommand(
    createTelegramCommandContext(ctx, deps.config),
    deps,
    deps.skillName,
    rawInput,
    options
  );
}
