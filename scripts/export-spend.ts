/**
 * Export spend analytics data to CSV or JSON.
 *
 * Usage:
 *   tsx scripts/export-spend.ts --wallet-id <id> [--days 30] [--format csv|json]
 *   tsx scripts/export-spend.ts --group-id <id> [--days 30] [--format csv|json]
 *   tsx scripts/export-spend.ts --summary [--wallet-id <id>|--group-id <id>] [--days 30]
 *
 * Output goes to stdout. Redirect with > output.csv.
 *
 * Privacy: no raw prompts, emails, private keys, or platform user IDs are exported.
 * Actor identifiers are pre-hashed in the database and shown as short hashes.
 */

import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";
import { SpendAnalyticsService } from "../src/analytics/SpendAnalyticsService.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const walletId = args["wallet-id"];
  const groupId = args["group-id"];
  const days = parseInt(args["days"] ?? "30", 10);
  const format = (args["format"] ?? "csv").toLowerCase();
  const summaryMode = args["summary"] === "true";

  if (!walletId && !groupId) {
    console.error("Usage: tsx scripts/export-spend.ts --wallet-id <id>|--group-id <id> [--days 30] [--format csv|json] [--summary]");
    process.exitCode = 1;
    return;
  }

  const config = parseConfig(process.env);
  const dbPath = config.DATABASE_PATH ?? ".data/agentcash-telegram.db";
  const db = new AppDatabase(dbPath);
  db.initialize();

  const analytics = new SpendAnalyticsService(db);

  if (summaryMode) {
    if (walletId) {
      const summary = analytics.getWalletSummary(walletId, days);
      if (format === "json") {
        process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      } else {
        process.stdout.write(analytics.formatWalletSummaryText(summary, `Wallet spend (${days} days)`) + "\n");
      }
    } else if (groupId) {
      const group = db.getGroupById(groupId);
      if (!group) {
        console.error(`Group ${groupId} not found.`);
        process.exitCode = 1;
        return;
      }
      const summary = analytics.getGroupSummary(groupId, group.wallet_id, days);
      if (format === "json") {
        process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      } else {
        process.stdout.write(analytics.formatWalletSummaryText(summary, `Group spend (${days} days)`) + "\n");
      }
    }
    db.close();
    return;
  }

  const rows = walletId
    ? analytics.getWalletExportRows(walletId, days)
    : analytics.getGroupExportRows(groupId!, days);

  if (format === "json") {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    process.stdout.write(analytics.formatExportCsv(rows) + "\n");
  }

  db.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
