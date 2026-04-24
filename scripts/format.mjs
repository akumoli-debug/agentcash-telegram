import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const allowedExtensions = new Set([
  ".ts",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".mjs",
  ".gitignore",
  ".example"
]);
const explicitFiles = new Set([".env.example", ".gitignore"]);

walk(repoRoot);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".data") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    const relative = path.relative(repoRoot, fullPath);
    const extension = path.extname(entry.name);

    if (!explicitFiles.has(entry.name) && !allowedExtensions.has(extension)) {
      continue;
    }

    const original = fs.readFileSync(fullPath, "utf8");
    const formatted = original
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n");

    const finalText = formatted.endsWith("\n") ? formatted : `${formatted}\n`;

    if (finalText !== original) {
      fs.writeFileSync(fullPath, finalText);
      console.error(`formatted ${relative}`);
    }
  }
}
