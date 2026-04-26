import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checks = ["format", "lint", "typecheck", "test", "build", "smoke:dry"] as const;

interface ValidationArtifact {
  schemaVersion: 1;
  generatedAt: string;
  gitCommit: string;
  checks: Array<{ name: string; status: "passed" }>;
}

function main(): void {
  const passed: ValidationArtifact["checks"] = [];

  for (const check of checks) {
    execFileSync("corepack", ["pnpm", check], {
      cwd: repoRoot,
      stdio: "inherit"
    });
    passed.push({ name: check, status: "passed" });
  }

  const artifact: ValidationArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
    checks: passed
  };

  const releaseDir = path.join(repoRoot, ".release");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(path.join(releaseDir, "validation.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stderr.write("[validate:release] wrote .release/validation.json\n");
}

function getGitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

main();
