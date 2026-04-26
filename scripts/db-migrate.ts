import { parseConfig } from "../src/config.js";
import { createDatabaseAdapter } from "../src/db/DatabaseAdapter.js";

async function main() {
  const config = parseConfig(process.env);
  const adapter = createDatabaseAdapter(config);
  await adapter.initialize();
  await adapter.close();
  console.error(`[db] migrations applied for ${adapter.provider}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
