import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

const requiredScripts = [
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
  "smoke:dry",
  "smoke:agentcash",
  "smoke:live",
  "validate:release",
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
  "AUDIT_STRICT_MODE",
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

export interface ReleaseCheckResult {
  failures: string[];
  warnings: string[];
}

export interface ReleaseCheckOptions {
  branchName?: string;
  latestCommit?: string;
  requireValidationArtifact?: boolean;
}

const MAIN_BRANCH_FIX_COMMANDS = [
  "git branch -m Main main",
  "git push origin main",
  "git push origin --delete Main",
  "gh repo edit --default-branch main"
];

export function runReleaseCheck(root = repoRoot, options: ReleaseCheckOptions = {}): ReleaseCheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  checkBranch(root, failures, options.branchName);
  checkValidationArtifact(root, failures, options);
  checkPackageScripts(root, failures);
  checkReadme(root, failures);
  checkPostgresOverclaims(root, failures);
  checkEnvExample(root, failures);
  checkRequiredDocs(root, failures);
  checkAgentCashLatestReferences(root, failures);
  checkDockerComposeHonesty(root, failures, warnings);
  checkIssueTemplates(root, failures);
  checkObviousSecrets(root, failures);

  return { failures, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, warnings } = runReleaseCheck();

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
    process.stderr.write("[release:check] validation artifact accepted\n");
  }
}

function checkPackageScripts(root: string, failures: string[]): void {
  const pkg = readJsonFile<{ scripts?: Record<string, string> }>(root, "package.json");
  for (const script of requiredScripts) {
    if (!pkg.scripts?.[script]) {
      failures.push(`package.json is missing script "${script}"`);
    }
  }
}

function checkReadme(root: string, failures: string[]): void {
  const text = readTextFile(root, "README.md");
  const lowered = text.toLowerCase();
  if (!lowered.includes("not production custody")) {
    failures.push('README.md must contain the phrase "not production custody"');
  }

  if (/\bproduction-ready\b/i.test(text)) {
    failures.push('README.md must not say "production-ready"; use "not production custody" wording instead');
  }

  const requiredSections = [
    "## Competitive Context",
    "## Why This Exists",
    "## Demo",
    "## Feature Status",
    "## Implementation Evidence",
    "## Payment Safety Model",
    "## Supported Platforms",
    "## Commands",
    "## Setup",
    "## Local Demo",
    "## Live Smoke Test",
    "## Tests",
    "## Security Posture",
    "## Roadmap",
    "## Why This Matters"
  ];

  for (const section of requiredSections) {
    if (!text.includes(section)) {
      failures.push(`README.md is missing section ${section}`);
    }
  }
}

function checkEnvExample(root: string, failures: string[]): void {
  const text = readTextFile(root, ".env.example");
  for (const envVar of requiredEnvVars) {
    if (!new RegExp(`^${envVar}=`, "m").test(text)) {
      failures.push(`.env.example is missing ${envVar}`);
    }
  }
}

function checkRequiredDocs(root: string, failures: string[]): void {
  const requiredPaths = [
    "docs/agentcash-cli.md",
    "docs/audit.md",
    "docs/execution-reconciliation.md",
    "docs/postgres-adapter-plan.md",
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
    if (!existsSync(path.join(root, docPath))) {
      failures.push(`${docPath} is missing`);
    }
  }
}

function checkPostgresOverclaims(root: string, failures: string[]): void {
  const readmePath = path.join(root, "README.md");
  if (existsSync(readmePath) && containsPostgresProductionReadyClaim(readFileSync(readmePath, "utf8"))) {
    failures.push(
      "README.md overclaims Postgres production readiness; use migration scaffold or future production DB target wording"
    );
  }

  for (const composePath of collectComposeFiles(root)) {
    const text = readFileSync(composePath, "utf8");
    if (composeClaimsProductionPostgresRuntime(text) && !composeDeclaresSkeletonCaveat(text)) {
      failures.push(
        `${path.relative(root, composePath)} implies production Postgres runtime support without a skeleton/scaffold caveat`
      );
    }
  }
}

function containsPostgresProductionReadyClaim(text: string): boolean {
  return /\bpostgres\b.{0,80}\bproduction[- ]ready\b/i.test(text) ||
    /\bproduction[- ]ready\b.{0,80}\bpostgres\b/i.test(text) ||
    /\bpostgres production path\b/i.test(text) ||
    /\bpostgres production (?:is )?(?:complete|ready|supported)\b/i.test(text);
}

function checkAgentCashLatestReferences(root: string, failures: string[]): void {
  const references = findAgentCashLatestReferences(root);
  for (const reference of references) {
    failures.push(`${reference} contains agentcash@latest; pin AgentCash CLI versions before release`);
  }
}

export function findAgentCashLatestReferences(root: string): string[] {
  const references: string[] = [];

  const candidates = [
    path.join(root, "src/config.ts"),
    path.join(root, ".env.example"),
    path.join(root, "README.md"),
    path.join(root, "package.json"),
    ...collectComposeFiles(root)
  ];
  const docsDir = path.join(root, "docs");
  if (existsSync(docsDir)) {
    candidates.push(...collectTextFiles(docsDir));
  }

  references.push(
    ...candidates
    .filter(file => existsSync(file) && statSync(file).isFile())
    .filter(file => readFileSync(file, "utf8").includes("agentcash@latest"))
      .map(file => path.relative(root, file))
  );

  return references;
}

function checkDockerComposeHonesty(root: string, failures: string[], warnings: string[]): void {
  const requiredComposeFiles = ["docker-compose.demo.yml", "docker-compose.prod-skeleton.yml"];
  for (const composeFile of requiredComposeFiles) {
    if (!existsSync(path.join(root, composeFile))) {
      failures.push(`${composeFile} is missing`);
    }
  }

  const defaultComposePath = path.join(root, "docker-compose.yml");
  if (existsSync(defaultComposePath)) {
    const text = readFileSync(defaultComposePath, "utf8");
    if (composeClaimsProductionWithUnsafeSqlite(text)) {
      failures.push(
        "docker-compose.yml claims NODE_ENV=production while forcing SQLite with ALLOW_SQLITE_IN_PRODUCTION"
      );
    }
  }

  for (const composePath of collectComposeFiles(root)) {
    const text = readFileSync(composePath, "utf8");
    if (hasPostgresService(text) && composeUsesSqliteRuntime(text)) {
      warnings.push(
        `${path.relative(root, composePath)} defines a Postgres service while DATABASE_PROVIDER=sqlite; Postgres is scaffold-only unless the runtime repository is wired to it`
      );
    }
  }
}

function collectComposeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith("docker-compose"))
    .map(entry => path.join(root, entry.name));
}

function composeClaimsProductionWithUnsafeSqlite(text: string): boolean {
  return hasComposeEnvValue(text, "NODE_ENV", "production") &&
    hasComposeEnvValue(text, "DATABASE_PROVIDER", "sqlite") &&
    hasComposeEnvValue(text, "ALLOW_SQLITE_IN_PRODUCTION", "true");
}

function hasPostgresService(text: string): boolean {
  return /^\s{2}postgres:\s*$/m.test(text);
}

function composeUsesSqliteRuntime(text: string): boolean {
  return hasComposeEnvValue(text, "DATABASE_PROVIDER", "sqlite");
}

function composeClaimsProductionPostgresRuntime(text: string): boolean {
  return hasComposeEnvValue(text, "NODE_ENV", "production") &&
    hasComposeEnvValue(text, "DATABASE_PROVIDER", "postgres");
}

function composeDeclaresSkeletonCaveat(text: string): boolean {
  return /not custody-ready|not a runnable\s+production claim|skeleton only/i.test(text);
}

function hasComposeEnvValue(text: string, key: string, value: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escapedKey}:\\s*["']?${escapedValue}["']?`, "i").test(text) ||
    new RegExp(`-\\s*${escapedKey}=${escapedValue}\\b`, "i").test(text);
}

function checkIssueTemplates(root: string, failures: string[]): void {
  const requiredPaths = [
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/security_limitation.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/pull_request_template.md"
  ];

  for (const templatePath of requiredPaths) {
    if (!existsSync(path.join(root, templatePath))) {
      failures.push(`${templatePath} is missing`);
    }
  }
}

function checkObviousSecrets(root: string, failures: string[]): void {
  const secretPatterns = [
    { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
    { name: "OpenAI API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
    { name: "Anthropic API key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: "Discord bot token", pattern: /[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/ },
    { name: "Telegram bot token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
    { name: "raw EVM private key", pattern: /\b0x[a-fA-F0-9]{64}\b/ },
    {
      name: "x402/private key assignment",
      pattern: /\b(?:X402_PRIVATE_KEY|PRIVATE_KEY|privateKey)\b\s*[:=]\s*["']?(?:0x[a-fA-F0-9]{64}|[A-Za-z0-9+/=]{40,})/i
    }
  ];

  for (const file of collectTextFiles(root)) {
    const relative = path.relative(root, file);
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(text)) {
        failures.push(`${relative} appears to contain an obvious ${name}`);
      }
    }
  }
}

function checkBranch(root: string, failures: string[], overrideBranch?: string): void {
  try {
    const branch = overrideBranch ?? gitOutput(root, ["branch", "--show-current"]);

    if (!branch) {
      failures.push("current git branch is detached or empty; release checks must run on main");
      return;
    }

    if (branch !== "main") {
      failures.push(
        [
          `current branch is "${branch}", not "main"`,
          "Fix with:",
          ...MAIN_BRANCH_FIX_COMMANDS.map(command => `  ${command}`)
        ].join("\n")
      );
    }
  } catch {
    failures.push("could not determine current git branch; release checks must run inside a git checkout on main");
  }
}

function checkValidationArtifact(
  root: string,
  failures: string[],
  options: ReleaseCheckOptions
): void {
  if (options.requireValidationArtifact === false) {
    return;
  }

  const artifactPath = path.join(root, ".release", "validation.json");
  if (!existsSync(artifactPath)) {
    failures.push(
      ".release/validation.json is missing; run `corepack pnpm validate:release` before `corepack pnpm release:check`"
    );
    return;
  }

  let artifact: {
    generatedAt?: string;
    gitCommit?: string;
    checks?: Array<{ name?: string; status?: string }>;
  };

  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as typeof artifact;
  } catch {
    failures.push(".release/validation.json is not valid JSON; rerun `corepack pnpm validate:release`");
    return;
  }

  const latestCommit = options.latestCommit ?? getGitCommit(root);
  if (artifact.gitCommit !== latestCommit) {
    failures.push(
      `.release/validation.json was generated for ${artifact.gitCommit ?? "unknown commit"}, not latest commit ${latestCommit}; rerun \`corepack pnpm validate:release\``
    );
  }

  const requiredChecks = ["format", "lint", "typecheck", "test", "build", "smoke:dry"];
  const passedChecks = new Set(
    (artifact.checks ?? [])
      .filter(check => check.status === "passed" && check.name)
      .map(check => check.name)
  );
  for (const check of requiredChecks) {
    if (!passedChecks.has(check)) {
      failures.push(`.release/validation.json is missing passed check "${check}"`);
    }
  }
}

function getGitCommit(root: string): string {
  return gitOutput(root, ["rev-parse", "HEAD"]);
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
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

function readTextFile(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJsonFile<T>(root: string, relativePath: string): T {
  return JSON.parse(readTextFile(root, relativePath)) as T;
}
