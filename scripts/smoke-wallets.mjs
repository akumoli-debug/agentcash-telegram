import crypto from "node:crypto";

const [maybeFlag, ...rest] = process.argv.slice(2);
const telegramIds = maybeFlag === "--print-only" ? rest : process.argv.slice(2);
const masterKey =
  process.env.MASTER_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
const keyBytes = Buffer.from(masterKey, "base64");

if (telegramIds.length === 0) {
  console.error("Usage: pnpm smoke:wallets -- <telegram_id> [telegram_id...]");
  process.exit(1);
}

for (const telegramId of telegramIds) {
  const homeHash = crypto
    .createHmac("sha256", keyBytes)
    .update(`telegram:${telegramId}`)
    .digest("hex")
    .slice(0, 24);

  process.stdout.write(`${telegramId} -> data/agentcash-homes/${homeHash}\n`);
}
