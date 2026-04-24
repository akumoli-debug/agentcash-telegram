import type { Context } from "telegraf";
import { type SkillExecutor, type SkillName } from "../agentcash/skillExecutor.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import {
  confirmationKeyboard,
  ensureUserRecord,
  getCommandArgument,
  getExecutionContext,
  replyWithSkillResult
} from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export interface SkillCommandDeps {
  config: AppConfig;
  db: AppDatabase;
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
  const user = ensureUserRecord(deps.db, ctx, deps.config.DEFAULT_SPEND_CAP_USDC);
  const executionContext = getExecutionContext(ctx);

  deps.db.upsertSession({
    userId: user.id,
    telegramChatId: executionContext.telegramChatId,
    currentCommand: deps.skillName,
    stateJson: null
  });

  const result = await deps.skillExecutor.execute(deps.skillName, rawInput, {
    ...executionContext,
    forceConfirmation: options?.forceConfirmation
  });

  if (result.type === "confirmation_required") {
    deps.db.upsertSession({
      userId: user.id,
      telegramChatId: executionContext.telegramChatId,
      currentCommand: deps.skillName,
      stateJson: JSON.stringify(result.pending)
    });

    await ctx.reply(result.text, confirmationKeyboard(result.pending.token));
    return;
  }

  deps.db.clearSessionState(user.id, executionContext.telegramChatId);
  await replyWithSkillResult(ctx, result);
}
