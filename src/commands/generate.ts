import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { SkillExecutor } from "../agentcash/skillExecutor.js";
import type { WalletManager } from "../wallets/walletManager.js";
import { createSkillCommand } from "./skillCommand.js";

export function createGenerateCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
}) {
  return createSkillCommand({
    ...deps,
    skillName: "generate"
  });
}
