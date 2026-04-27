// Revoke all pairing codes (pending and approved) for a specific actor.
// Usage: npx tsx scripts/revoke-user.ts <platform> <actor-id-hash>
// platform: telegram | discord
// actor-id-hash: the 24-char hex hash logged in audit events or pairing approvals.
import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";

async function main() {
  const platform = process.argv[2];
  const actorIdHash = process.argv[3];

  if (!platform || !actorIdHash) {
    console.error("Usage: npx tsx scripts/revoke-user.ts <platform> <actor-id-hash>");
    console.error("  platform: telegram | discord");
    console.error("  actor-id-hash: 24-char hash shown in approve-pairing output or audit logs");
    process.exitCode = 1;
    return;
  }

  if (platform !== "telegram" && platform !== "discord") {
    console.error("platform must be 'telegram' or 'discord'");
    process.exitCode = 1;
    return;
  }

  const config = parseConfig(process.env);
  const db = new AppDatabase(config.DATABASE_PATH);
  db.initialize();

  const revoked = db.revokeActorPairingCodes(platform, actorIdHash);
  if (revoked > 0) {
    console.log(`Revoked ${revoked} pairing code(s) for ${platform} actor ${actorIdHash}.`);
    console.log("Also remove this actor from TELEGRAM_ALLOWED_USERS / DISCORD_ALLOWED_USERS if present.");
  } else {
    console.log("No active pairing codes found for that actor (already expired/revoked or never paired).");
  }

  db.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
