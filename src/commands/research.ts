import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { SkillExecutor } from "../agentcash/skillExecutor.js";
import type { ResearchWorkflowService } from "../research/ResearchWorkflowService.js";
import type { WalletManager } from "../wallets/walletManager.js";
import {
  createTelegramCommandContext,
  getCommandArgument,
  isPrivateTelegramChat,
  replyDmInstructionForUserWalletCommand
} from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export function createResearchCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
  researchWorkflowService?: ResearchWorkflowService;
}) {
  return async (ctx: import("telegraf").Context) => {
    try {
      if (!isPrivateTelegramChat(ctx)) {
        await replyDmInstructionForUserWalletCommand(ctx);
        return;
      }

      if (!deps.researchWorkflowService) {
        const { createSkillCommand } = await import("./skillCommand.js");
        return createSkillCommand({ ...deps, skillName: "research" })(ctx);
      }

      const commandContext = createTelegramCommandContext(ctx, deps.config);
      const user = deps.db.upsertUser({
        telegramUserId: commandContext.walletScope.walletOwnerId,
        defaultSpendCapUsdc: deps.config.DEFAULT_SPEND_CAP_USDC
      });

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: commandContext.walletScope.chatId,
        currentCommand: "research",
        stateJson: null
      });

      const result = await deps.researchWorkflowService.planAndQuote(getCommandArgument(ctx), {
        telegramId: commandContext.walletScope.walletOwnerId,
        telegramProfile: commandContext.actorProfile,
        telegramChatId: commandContext.walletScope.chatId,
        telegramChatType: commandContext.walletScope.chatType,
        telegramMessageId: commandContext.messageId ?? null
      });

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: commandContext.walletScope.chatId,
        currentCommand: "research",
        stateJson: JSON.stringify({ type: "quote_confirmation", quote_id: result.quoteId })
      });

      await commandContext.confirm({
        text: result.text,
        quoteId: result.quoteId,
        skill: "research"
      });
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
