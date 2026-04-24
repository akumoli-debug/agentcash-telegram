import { getConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { AppDatabase } from "./db/client.js";
import { WalletManager } from "./wallets/walletManager.js";
import { AgentCashClient } from "./agentcash/agentcashClient.js";
import { SkillExecutor } from "./agentcash/skillExecutor.js";
import { RouterClient } from "./router/routerClient.js";
import { createBot } from "./bot.js";

async function main() {
  const config = getConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = new AppDatabase(config.DATABASE_PATH);

  db.initialize();

  const agentcashClient = new AgentCashClient(config);
  const walletManager = new WalletManager(db, config, agentcashClient);
  const skillExecutor = new SkillExecutor(db, walletManager, agentcashClient, logger, config);
  const routerClient = new RouterClient(config, logger);
  const bot = createBot({
    config,
    logger,
    db,
    walletManager,
    skillExecutor,
    routerClient
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    bot.stop(signal);
    db.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (config.BOT_MODE === "webhook") {
    await bot.launch({
      webhook: {
        domain: config.WEBHOOK_DOMAIN!,
        path: config.WEBHOOK_PATH,
        host: config.WEBHOOK_HOST,
        port: config.WEBHOOK_PORT,
        secretToken: config.WEBHOOK_SECRET_TOKEN || undefined
      }
    });
    logger.info(
      {
        mode: "webhook",
        webhookPath: config.WEBHOOK_PATH,
        webhookPort: config.WEBHOOK_PORT
      },
      "agentcash-telegram bot started"
    );
    return;
  }

  await bot.launch();
  logger.info({ mode: "polling" }, "agentcash-telegram bot started");
}

void main();
