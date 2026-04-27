try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.prepare("select 1 as ok").get();
  db.close();
} catch (error) {
  console.error("better-sqlite3 native bindings are unavailable.");
  console.error("");
  console.error(`Node: ${process.version}`);
  console.error(`Platform: ${process.platform} ${process.arch}`);
  console.error("");
  console.error("Use the repo-supported Node version and rebuild the native package:");
  console.error("  nvm install");
  console.error("  nvm use");
  console.error("  corepack enable");
  console.error("  corepack pnpm install");
  console.error("  corepack pnpm rebuild better-sqlite3");
  console.error("");

  if (error instanceof Error) {
    console.error(`${error.name}: ${error.message}`);
  } else {
    console.error(String(error));
  }

  process.exit(1);
}
