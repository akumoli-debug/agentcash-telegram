import { once } from "node:events";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import { parseConfig, type AppConfig } from "../src/config.js";
import { buildDiscordCommandPayload } from "../src/discordBot.js";
import { AppDatabase } from "../src/db/client.js";
import { encryptSecret } from "../src/lib/crypto.js";
import type { AppLogger } from "../src/lib/logger.js";
import { startHealthServer } from "../src/healthServer.js";
import { ResearchWorkflowService } from "../src/research/ResearchWorkflowService.js";
import { WalletManager } from "../src/wallets/walletManager.js";

interface SmokeOptions {
  dryRun: boolean;
  telegram: boolean;
  discord: boolean;
  agentcash: boolean;
  noFunds: boolean;
}

const DRY_RUN_MASTER_KEY = Buffer.alloc(32, 77).toString("base64");

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => logger
} as unknown as AppLogger;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    await runDrySmoke(options);
    return;
  }

  await runLiveSmoke(options);
}

function parseArgs(args: string[]): SmokeOptions {
  return {
    dryRun: args.includes("--dry-run"),
    telegram: args.includes("--telegram"),
    discord: args.includes("--discord"),
    agentcash: args.includes("--agentcash"),
    noFunds: args.includes("--no-funds")
  };
}

async function runDrySmoke(options: SmokeOptions): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentcash-telegram-smoke-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "dry-run-telegram-token",
    TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || "agentcash_dry_run_bot",
    DISCORD_BOT_TOKEN:
      options.discord || process.env.DISCORD_BOT_TOKEN
        ? process.env.DISCORD_BOT_TOKEN || "dry-run-discord-token"
        : process.env.DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID:
      options.discord || process.env.DISCORD_APPLICATION_ID
        ? process.env.DISCORD_APPLICATION_ID || "000000000000000000"
        : process.env.DISCORD_APPLICATION_ID,
    DATABASE_PATH: path.join(tempDir, "smoke.db"),
    MASTER_ENCRYPTION_KEY: process.env.MASTER_ENCRYPTION_KEY || DRY_RUN_MASTER_KEY,
    AGENTCASH_HOME_ROOT: path.join(tempDir, "agentcash-homes"),
    HEALTH_HOST: "127.0.0.1",
    HEALTH_PORT: "0",
    SKIP_AGENTCASH_HEALTHCHECK: process.env.SKIP_AGENTCASH_HEALTHCHECK || "true"
  };

  let db: AppDatabase | undefined;

  try {
    const config = parseConfig(env);
    db = new AppDatabase(config.DATABASE_PATH);
    db.initialize();
    step("config loaded and SQLite schema initialized");

    const agentcashClient = new AgentCashClient(config);
    if (config.SKIP_AGENTCASH_HEALTHCHECK) {
      step("AgentCash CLI health check skipped by SKIP_AGENTCASH_HEALTHCHECK=true");
    } else {
      await agentcashClient.healthCheck();
      step("AgentCash CLI health check passed");
    }

    await verifyTelegramModulesImport();
    step("Telegram command registration modules import successfully");

    const discordPayload = buildDiscordCommandPayload();
    assert(discordPayload.length > 0, "Discord command payload is empty");
    step("Discord /ac command payload builds successfully");

    const server = startHealthServer(config, logger);
    await once(server, "listening");
    await requestHealth(server);
    await closeServer(server);
    step("health server starts, answers /healthz, and closes cleanly");

    await exerciseQuoteFlow(config, db);
    step("agentic research quote and confirmation flow completes against a fake AgentCash client");

    step("dry-run smoke complete");
  } finally {
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyTelegramModulesImport(): Promise<void> {
  await Promise.all([
    import("../src/bot.js"),
    import("../src/commands/start.js"),
    import("../src/commands/balance.js"),
    import("../src/commands/deposit.js"),
    import("../src/commands/cap.js"),
    import("../src/commands/history.js"),
    import("../src/commands/groupWallet.js"),
    import("../src/commands/inlineMode.js")
  ]);
}

async function exerciseQuoteFlow(config: AppConfig, db: AppDatabase): Promise<void> {
  const fakeAgentCash = makeFakeAgentCashClient(config);
  const walletManager = new WalletManager(db, config, fakeAgentCash);
  const researchWorkflowService = new ResearchWorkflowService(db, walletManager, fakeAgentCash, logger, config);

  const quote = await researchWorkflowService.planAndQuote("x402 verification smoke", {
    telegramId: "dry-run-user",
    telegramChatId: "dry-run-user",
    telegramChatType: "private"
  });

  assert(quote.type === "confirmation_required", "expected a confirmation-required quote");

  const result = await researchWorkflowService.executeApprovedQuote(quote.quoteId, {
    telegramId: "dry-run-user",
    telegramChatId: "dry-run-user",
    telegramChatType: "private"
  });

  assert(result.type === "completed", "expected approved quote to complete");
  const quoteCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM quotes").get() as { count: number };
  const successCount = db.sqlite
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'success'")
    .get() as { count: number };

  assert(quoteCount.count === 1, "quote was not recorded");
  assert(
    successCount.count === 1,
    "successful transaction was not recorded"
  );
}

function makeFakeAgentCashClient(config: AppConfig): AgentCashClient {
  return {
    healthCheck: async () => {},
    ensureWallet: async () => ({
      address: "0x0000000000000000000000000000000000000001",
      network: "base",
      depositLink: "https://example.test/deposit",
      encryptedPrivateKey: encryptSecret("0x" + "11".repeat(32), config.MASTER_ENCRYPTION_KEY),
      raw: { ok: true }
    }),
    getBalance: async () => ({
      address: "0x0000000000000000000000000000000000000001",
      network: "base",
      usdcBalance: 10,
      depositLink: "https://example.test/deposit",
      raw: { ok: true }
    }),
    getDepositInfo: async () => ({
      address: "0x0000000000000000000000000000000000000001",
      network: "base",
      depositLink: "https://example.test/deposit",
      raw: { ok: true }
    }),
    checkEndpoint: async () => ({ estimatedCostCents: 25, raw: { price: 0.25 } }),
    fetchJson: async () => ({
      raw: { data: { results: [{ title: "Smoke result", url: "https://example.test" }] } },
      data: { results: [{ title: "Smoke result", url: "https://example.test" }] },
      actualCostCents: 25,
      txHash: "0xsmoke"
    }),
    pollJob: async () => ({ raw: {}, data: {}, actualCostCents: 0 }),
    getHomeDir: () => path.join(os.tmpdir(), "agentcash-smoke-home"),
    extractImageUrl: () => undefined,
    extractJobId: () => undefined,
    extractJobLink: () => undefined,
    extractCostCents: () => undefined
  } as unknown as AgentCashClient;
}

async function runLiveSmoke(options: SmokeOptions): Promise<void> {
  const config = parseConfig(process.env);
  const client = new AgentCashClient(config);

  if (options.agentcash) {
    await client.healthCheck();
    step("AgentCash CLI health check passed");
  }

  if (options.telegram) {
    requireEnv("TELEGRAM_BOT_TOKEN");
    printTelegramChecklist();
  }

  if (options.discord) {
    requireEnv("DISCORD_BOT_TOKEN");
    requireEnv("DISCORD_APPLICATION_ID");
    const payload = buildDiscordCommandPayload();
    assert(payload.length > 0, "Discord command payload is empty");
    step("Discord command payload builds locally; live command registration happens on app startup");
    printDiscordChecklist();
  }

  if (options.noFunds || process.env.LIVE_FUNDS_TEST !== "true") {
    step("no automated paid call submitted; set LIVE_FUNDS_TEST=true only when you are intentionally doing the manual funded steps");
  } else {
    step("LIVE_FUNDS_TEST=true detected; this harness still leaves funded execution to the manual checklist");
  }
}

function printTelegramChecklist(): void {
  console.error("\nTelegram live smoke checklist:");
  console.error("1. Start the app with corepack pnpm dev or the deployed process.");
  console.error("2. DM the bot /start and verify a masked wallet/deposit response.");
  console.error("3. Run /deposit and /balance.");
  console.error("4. Run /cap 0.25.");
  console.error("5. Run /research latest x402 ecosystem activity.");
  console.error("6. If a confirmation appears, press Confirm once and verify a replayed Confirm is rejected.");
  console.error("7. Run /history and verify the sanitized request hash and cost fields appear.");
  console.error("8. In a Telegram group, make the bot admin, then run /groupwallet create, /groupwallet sync-admins, /groupwallet roles, and /groupwallet balance.");
  console.error("9. From a non-admin group member, verify /groupwallet create and /groupwallet cap are refused.");
  console.error("10. In inline mode, type @<bot username> research x402 and verify the preview does not execute until opened/confirmed.");
}

function printDiscordChecklist(): void {
  console.error("\nDiscord live smoke checklist:");
  console.error("1. Install the app with bot and applications.commands scopes.");
  console.error("2. Start the app and wait for global /ac command registration.");
  console.error("3. In a DM, run /ac wallet balance and /ac wallet deposit.");
  console.error("4. In a DM, run /ac wallet research query:latest x402 ecosystem activity.");
  console.error("5. If confirmation appears, press Confirm once and verify a replayed button is rejected.");
  console.error("6. In a guild channel as a non-manager, verify /ac guild create is refused.");
  console.error("7. In a guild channel as Manage Server/Admin, run /ac guild create, /ac guild sync-admins, /ac guild balance, and /ac guild research query:latest x402 ecosystem activity.");
}

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(`${name} is required for live smoke mode`);
  }
}

async function requestHealth(server: http.Server): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("health server did not expose an address");
  }

  await new Promise<void>((resolve, reject) => {
    const req = http.get(
      {
        host: address.address,
        port: address.port,
        path: "/healthz"
      },
      res => {
        if (res.statusCode !== 200) {
          reject(new Error(`health endpoint returned ${res.statusCode}`));
          return;
        }

        res.resume();
        res.on("end", resolve);
      }
    );

    req.on("error", reject);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function step(message: string): void {
  console.error(`[smoke] ${message}`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
