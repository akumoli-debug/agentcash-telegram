import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { SkillExecutor } from "../agentcash/skillExecutor.js";
import { createSkillCommand } from "./skillCommand.js";

export function createEnrichCommand(deps: {
  config: AppConfig;
  db: AppDatabase;
  skillExecutor: SkillExecutor;
}) {
  return createSkillCommand({
    ...deps,
    skillName: "enrich"
  });
}
