import { getConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { AppDatabase } from "./db/client.js";
import { assertRuntimeDatabaseAdapterImplemented, createDatabaseAdapter } from "./db/DatabaseAdapter.js";
import { WalletManager } from "./wallets/walletManager.js";
import { AgentCashClient } from "./agentcash/agentcashClient.js";
import { SkillExecutor } from "./agentcash/skillExecutor.js";
import { RouterClient } from "./router/routerClient.js";
import { createBot } from "./bot.js";
import { createDiscordBot, registerDiscordCommands } from "./discordBot.js";
import { startHealthServer } from "./healthServer.js";
import { createLockManager } from "./locks/LockManager.js";
import { createAuditSink } from "./audit/AuditSink.js";
import { AuditOutboxWorker } from "./audit/AuditOutboxWorker.js";
import { buildSecurityPolicyConfig } from "./gateway/buildPolicyConfig.js";

const ALLOWED_TELEGRAM_UPDATES = [
  "message",
  "callback_query",
  "inline_query",
  "chat_member",
  "my_chat_member"
];

async function main() {
  const config = getConfig();
  const logger = createLogger(config.LOG_LEVEL);
  assertRuntimeDatabaseAdapterImplemented(config);
  const adapter = createDatabaseAdapter(config);
  const db = adapter as unknown as AppDatabase;

  db.initialize();
  const agentcashClient = new AgentCashClient(config);
  const lockManager = createLockManager(config);
  const auditOutboxWorker =
    config.AUDIT_SINK === "database"
      ? null
      : new AuditOutboxWorker(db, createAuditSink(config, db), config.AUDIT_SINK, logger);
  const healthServer = startHealthServer(config, logger, [
    {
      name: "database",
      check: () => {
        db.sqlite.prepare("SELECT 1").get();
      }
    },
    {
      name: "lock",
      check: async () => {
        const lease = await lockManager.acquire("readiness", 1000);
        await lockManager.release(lease);
      }
    },
    {
      name: "custody",
      check: async () => {
        if (!config.SKIP_AGENTCASH_HEALTHCHECK) {
          await agentcashClient.healthCheck();
        }
      }
    },
    {
      name: "platform",
      check: () => {
        if (!config.TELEGRAM_BOT_TOKEN && !config.DISCORD_BOT_TOKEN) {
          throw new Error("no platform token configured");
        }
      }
    },
    {
      name: "audit_sink",
      check: async () => {
        if (config.AUDIT_STRICT_MODE && auditOutboxWorker) {
          await auditOutboxWorker.checkSinkHealth();
        }
      }
    }
  ]);

  if (config.NODE_ENV === "production" && config.ALLOW_INSECURE_LOCAL_CUSTODY) {
    logger.warn(
      {
        custodyMode: config.CUSTODY_MODE,
        allowInsecureLocalCustody: true
      },
      "!!! INSECURE LOCAL CUSTODY OVERRIDE ENABLED. DEMO-ONLY CLI KEY HANDLING IS RUNNING IN PRODUCTION. DO NOT USE FOR FINAL CUSTODY."
    );
  }

  if (config.SKIP_AGENTCASH_HEALTHCHECK) {
    logger.warn(
      {
        nodeEnv: config.NODE_ENV,
        skipAgentCashHealthcheck: true
      },
      "!!! AGENTCASH CLI HEALTH CHECK SKIPPED. LOCAL/TEST DEMO ONLY. DO NOT USE WITH REAL FUNDS OR PRODUCTION."
    );
  } else {
    logger.info({ custodyMode: config.CUSTODY_MODE }, "running custody health check...");
    try {
      await agentcashClient.healthCheck();
      logger.info({ custodyMode: config.CUSTODY_MODE }, "custody health check passed");
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) } },
        "custody health check failed — startup aborted"
      );
      process.exit(1);
    }
  }

  const walletManager = new WalletManager(db, config, agentcashClient, lockManager);
  const skillExecutor = new SkillExecutor(db, walletManager, agentcashClient, logger, config, lockManager);
  const routerClient = new RouterClient(config, logger);
  const securityPolicy = buildSecurityPolicyConfig(config);
  const bot = config.TELEGRAM_BOT_TOKEN
    ? createBot({ config, logger, db, walletManager, skillExecutor, routerClient, securityPolicy })
    : null;
  const discordBot = config.DISCORD_BOT_TOKEN
    ? createDiscordBot({ config, logger, db, walletManager, skillExecutor, securityPolicy })
    : null;
  auditOutboxWorker?.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    auditOutboxWorker?.stop();
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
      },
      allowedUpdates: ALLOWED_TELEGRAM_UPDATES as never
    });
    logger.info(
      { mode: "webhook", webhookPath: config.WEBHOOK_PATH, webhookPort: config.WEBHOOK_PORT },
      "agentcash-telegram bot started"
    );
    return;
  }

  if (bot) {
    await bot.launch({ allowedUpdates: ALLOWED_TELEGRAM_UPDATES as never });
  }
  logger.info({ mode: "polling" }, "agentcash-telegram bot started");
}

void main();
