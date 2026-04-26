import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const failures: string[] = [];
const warnings: string[] = [];

const requiredScripts = [
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
  "smoke:dry",
  "smoke:agentcash",
  "smoke:live",
  "release:check"
];

const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DATABASE_PROVIDER",
  "DATABASE_URL",
  "LOCK_PROVIDER",
  "REDIS_URL",
  "AUDIT_SINK",
  "AUDIT_HTTP_ENDPOINT",
  "NODE_ENV",
  "BOT_MODE",
  "WEBHOOK_SECRET_TOKEN",
  "AGENTCASH_COMMAND",
  "AGENTCASH_ARGS",
  "DEFAULT_SPEND_CAP_USDC",
  "HARD_SPEND_CAP_USDC",
  "ALLOW_UNQUOTED_DEV_CALLS",
  "SKIP_AGENTCASH_HEALTHCHECK",
  "CUSTODY_MODE",
  "ALLOW_INSECURE_LOCAL_CUSTODY",
  "REMOTE_SIGNER_URL",
  "MASTER_ENCRYPTION_KEY"
];

checkPackageScripts();
checkReadme();
checkEnvExample();
checkRequiredDocs();
checkIssueTemplates();
checkObviousSecrets();
checkBranch();

if (warnings.length > 0) {
  for (const warning of warnings) {
    process.stderr.write(`[release:check] warning: ${warning}\n`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`[release:check] failure: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stderr.write("[release:check] release package checks passed\n");
  process.stderr.write("[release:check] run tests with: corepack pnpm test\n");
}

function checkPackageScripts(): void {
  const pkg = readJsonFile<{ scripts?: Record<string, string> }>("package.json");
  for (const script of requiredScripts) {
    if (!pkg.scripts?.[script]) {
      failures.push(`package.json is missing script "${script}"`);
    }
  }
}

function checkReadme(): void {
  const text = readTextFile("README.md");
  if (!text.toLowerCase().includes("not production-ready custody")) {
    failures.push('README.md must contain the phrase "not production-ready custody"');
  }

  const requiredSections = [
    "## Demo",
    "## What Works Today",
    "## Experimental Features",
    "## Payment Safety Model",
    "## Supported Platforms",
    "## Commands",
    "## Setup",
    "## Local Demo",
    "## Live Smoke Test",
    "## Tests",
    "## Security Posture",
    "## Roadmap",
    "## Why This Matters For AgentCash/Merit"
  ];

  for (const section of requiredSections) {
    if (!text.includes(section)) {
      failures.push(`README.md is missing section ${section}`);
    }
  }
}

function checkEnvExample(): void {
  const text = readTextFile(".env.example");
  for (const envVar of requiredEnvVars) {
    if (!new RegExp(`^${envVar}=`, "m").test(text)) {
      failures.push(`.env.example is missing ${envVar}`);
    }
  }
}

function checkRequiredDocs(): void {
  const requiredPaths = [
    "docs/readiness.md",
    "docs/custody-review.md",
    "docs/security.md",
    "docs/deployment.md",
    "docs/demo-script.md",
    "docs/evaluator-guide.md",
    "docs/release-checklist.md",
    "docs/diagrams/architecture.mmd",
    "docs/diagrams/quote_flow.mmd",
    "docs/diagrams/custody_modes.mmd",
    "docs/diagrams/telegram_group_wallet_flow.mmd",
    "docs/diagrams/discord_flow.mmd"
  ];

  for (const docPath of requiredPaths) {
    if (!existsSync(path.join(repoRoot, docPath))) {
      failures.push(`${docPath} is missing`);
    }
  }
}

function checkIssueTemplates(): void {
  const requiredPaths = [
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/security_limitation.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/pull_request_template.md"
  ];

  for (const templatePath of requiredPaths) {
    if (!existsSync(path.join(repoRoot, templatePath))) {
      failures.push(`${templatePath} is missing`);
    }
  }
}

function checkObviousSecrets(): void {
  const secretPatterns = [
    { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
    { name: "OpenAI API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
    { name: "Discord bot token", pattern: /[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/ },
    { name: "Telegram bot token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ }
  ];

  for (const file of collectTextFiles(repoRoot)) {
    const relative = path.relative(repoRoot, file);
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(text)) {
        failures.push(`${relative} appears to contain an obvious ${name}`);
      }
    }
  }
}

function checkBranch(): void {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (branch && branch !== "main") {
      warnings.push(`current branch is "${branch}", not "main"`);
    }
  } catch {
    warnings.push("could not determine current git branch");
  }
}

function collectTextFiles(dir: string): string[] {
  const ignoredDirs = new Set([".git", "node_modules", "dist", ".data", "coverage"]);
  const allowedExtensions = new Set([
    ".ts",
    ".js",
    ".mjs",
    ".json",
    ".md",
    ".mmd",
    ".yaml",
    ".yml",
    ".example",
    ".sql"
  ]);
  const explicitFiles = new Set([".env.example", ".gitignore", "Dockerfile"]);
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...collectTextFiles(path.join(dir, entry.name)));
      }
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (explicitFiles.has(entry.name) || allowedExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files.filter(file => statSync(file).size < 1_000_000);
}

function readTextFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readTextFile(relativePath)) as T;
}
