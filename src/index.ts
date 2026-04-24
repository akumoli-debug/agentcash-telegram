import { getConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { AppDatabase } from "./db/client.js";
import { WalletManager } from "./wallets/walletManager.js";
import { AgentCashClient } from "./agentcash/agentcashClient.js";
import { SkillExecutor } from "./agentcash/skillExecutor.js";
import { RouterClient } from "./router/routerClient.js";
import { createBot } from "./bot.js";
import { createDiscordBot, registerDiscordCommands } from "./discordBot.js";
import { startHealthServer } from "./healthServer.js";

async function main() {
  const config = getConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = new AppDatabase(config.DATABASE_PATH);

  db.initialize();
  const healthServer = startHealthServer(config, logger);

  const agentcashClient = new AgentCashClient(config);

  logger.info("running AgentCash CLI health check...");
  try {
    await agentcashClient.healthCheck();
    logger.info("AgentCash CLI health check passed");
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) } },
      "AgentCash CLI health check failed — startup aborted"
    );
    process.exit(1);
  }

  const walletManager = new WalletManager(db, config, agentcashClient);
  const skillExecutor = new SkillExecutor(db, walletManager, agentcashClient, logger, config);
  const routerClient = new RouterClient(config, logger);
  const bot = config.TELEGRAM_BOT_TOKEN
    ? createBot({ config, logger, db, walletManager, skillExecutor, routerClient })
    : null;
  const discordBot = config.DISCORD_BOT_TOKEN
    ? createDiscordBot({ config, logger, db, walletManager, skillExecutor })
    : null;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    if (bot) {
      bot.stop(signal);
    }
    if (discordBot) {
      discordBot.destroy();
    }
    healthServer.close();
    db.close();
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  if (discordBot && config.DISCORD_BOT_TOKEN) {
    await registerDiscordCommands(config);
    await discordBot.login(config.DISCORD_BOT_TOKEN);
  }

  if (bot && config.BOT_MODE === "webhook") {
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
      { mode: "webhook", webhookPath: config.WEBHOOK_PATH, webhookPort: config.WEBHOOK_PORT },
      "agentcash-telegram bot started"
    );
    return;
  }

  if (bot) {
    await bot.launch();
  }
  logger.info({ mode: "polling" }, "agentcash-telegram bot started");
}

void main();
