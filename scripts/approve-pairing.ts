// Approve a pending pairing code by its code value.
// Usage: npx tsx scripts/approve-pairing.ts <code>
// The code is the 8-char hex string the user received in DM.
import crypto from "node:crypto";
import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";

async function main() {
  const code = process.argv[2];
  if (!code || code.length !== 8) {
    console.error("Usage: npx tsx scripts/approve-pairing.ts <8-char-code>");
    process.exitCode = 1;
    return;
  }

  const config = parseConfig(process.env);
  const db = new AppDatabase(config.DATABASE_PATH);
  db.initialize();

  const codeHash = crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");

  // Find any pending code matching this hash across all platforms.
  const row = db.sqlite
    .prepare(
      `SELECT * FROM gateway_pairing_codes WHERE code_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1`
    )
    .get(codeHash, new Date().toISOString()) as { id: string; platform: string; actor_id_hash: string } | undefined;

  if (!row) {
    console.error("No pending pairing code found for that value (expired or already used).");
    process.exitCode = 1;
    db.close();
    return;
  }

  const approved = db.approvePairingCode(row.id);
  if (approved) {
    console.log(`Approved pairing code for actor on platform=${row.platform}`);
    console.log(`Actor hash: ${row.actor_id_hash}`);
    console.log("Add this actor hash to TELEGRAM_ALLOWED_USERS or DISCORD_ALLOWED_USERS to make it persistent across restarts.");
  } else {
    console.error("Failed to approve (race condition or already approved).");
    process.exitCode = 1;
  }

  db.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
