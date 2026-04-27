import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/db/client.js";

const quoteId = process.argv[2];

if (!quoteId) {
  process.stderr.write("Usage: tsx scripts/mark-execution-reviewed.ts <quote_id>\n");
  process.exit(1);
}

const config = parseConfig(process.env);
const db = new AppDatabase(config.DATABASE_PATH);

try {
  db.initialize();
  const reviewed = db.markExecutionReviewed(quoteId);
  if (!reviewed) {
    process.stderr.write(`No execution_unknown quote found for ${quoteId}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Marked ${quoteId} reviewed\n`);
  }
} finally {
  db.close();
}
