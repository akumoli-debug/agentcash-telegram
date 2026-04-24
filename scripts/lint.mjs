import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const files = collectFiles(repoRoot);
const failures = [];

for (const file of files) {
  const relative = path.relative(repoRoot, file);
  const text = fs.readFileSync(file, "utf8");

  if (/console\.log\(/.test(text)) {
    failures.push(`${relative}: console.log is not allowed`);
  }

  if (/\bdebugger\b/.test(text)) {
    failures.push(`${relative}: debugger is not allowed`);
  }
}

const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
if (!gitignore.split("\n").includes(".env")) {
  failures.push(".gitignore: missing .env ignore rule");
}

const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
if (!/TELEGRAM_BOT_TOKEN=replace-me/.test(envExample)) {
  failures.push(".env.example: TELEGRAM_BOT_TOKEN must use a placeholder");
}

if (!/MASTER_ENCRYPTION_KEY=replace-with-32-byte-base64-key/.test(envExample)) {
  failures.push(".env.example: MASTER_ENCRYPTION_KEY must use a placeholder");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.error(`lint passed (${files.length} files checked)`);

function collectFiles(dir) {
  const collected = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".data" ||
      entry.name === ".env" ||
      entry.name === "scripts"
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collected.push(...collectFiles(fullPath));
      continue;
    }

    if (
      [".ts", ".md", ".json", ".yaml", ".yml", ".mjs"].includes(path.extname(entry.name)) ||
      entry.name === ".env.example" ||
      entry.name === ".gitignore"
    ) {
      collected.push(fullPath);
    }
  }

  return collected;
}
