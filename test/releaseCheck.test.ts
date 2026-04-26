import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReleaseCheck } from "../scripts/release-check.js";

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

const requiredReadmeSections = [
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

const requiredDocs = [
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

const requiredTemplates = [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/security_limitation.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/pull_request_template.md"
];

describe("release check", () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it("fails when current branch is not main", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n");

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "Main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures.join("\n")).toContain('current branch is "Main", not "main"');
    expect(result.failures.join("\n")).toContain("git branch -m Main main");
    expect(result.failures.join("\n")).toContain("gh repo edit --default-branch main");
  });

  it("fails when @latest appears in AgentCash release-controlled files", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@latest\n");

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures).toContain(
      ".env.example contains agentcash@latest; pin AgentCash CLI versions before release"
    );
  });

  it("fails when default compose claims production with unsafe SQLite override", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n", {
      defaultCompose: [
        "services:",
        "  app:",
        "    environment:",
        "      NODE_ENV: production",
        "      DATABASE_PROVIDER: sqlite",
        "      ALLOW_SQLITE_IN_PRODUCTION: \"true\""
      ].join("\n")
    });

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures).toContain(
      "docker-compose.yml claims NODE_ENV=production while forcing SQLite with ALLOW_SQLITE_IN_PRODUCTION"
    );
  });

  it("warns when a compose file defines Postgres while app runtime remains SQLite", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n", {
      defaultCompose: [
        "services:",
        "  app:",
        "    environment:",
        "      NODE_ENV: development",
        "      DATABASE_PROVIDER: sqlite",
        "  postgres:",
        "    image: postgres:16-alpine"
      ].join("\n")
    });

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.warnings).toContain(
      "docker-compose.yml defines a Postgres service while DATABASE_PROVIDER=sqlite; Postgres is scaffold-only unless the runtime repository is wired to it"
    );
  });

  it("fails when README overclaims Postgres production readiness", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n", {
      readmeExtra: "Postgres production ready."
    });

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures).toContain(
      "README.md overclaims Postgres production readiness; use migration scaffold or future production DB target wording"
    );
  });

  it("fails when compose claims production Postgres runtime without a skeleton caveat", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n", {
      prodSkeletonCompose: [
        "services:",
        "  app:",
        "    environment:",
        "      NODE_ENV: production",
        "      DATABASE_PROVIDER: postgres"
      ].join("\n")
    });

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures).toContain(
      "docker-compose.prod-skeleton.yml implies production Postgres runtime support without a skeleton/scaffold caveat"
    );
  });

  it("readiness docs describe Postgres as a scaffold, not runtime-ready", () => {
    const text = readFileSync(path.join(process.cwd(), "docs/readiness.md"), "utf8");

    expect(text).toContain("Postgres is a migration scaffold and future production DB target only");
    expect(text).not.toMatch(/Postgres production ready/i);
  });

  it("passes on a clean release fixture", () => {
    fixtureRoot = makeReleaseFixture("AGENTCASH_ARGS=agentcash@0.14.3\n");

    const result = runReleaseCheck(fixtureRoot, {
      branchName: "main",
      latestCommit: "fixture-commit"
    });

    expect(result.failures).toEqual([]);
  });
});

function makeReleaseFixture(
  envLine: string,
  overrides: { defaultCompose?: string; prodSkeletonCompose?: string; readmeExtra?: string } = {}
): string {
  const root = mkdtempSync(path.join(tmpdir(), "agentcash-release-check-"));
  writeFile(root, "package.json", JSON.stringify({ scripts: Object.fromEntries(requiredScripts.map(script => [script, "echo ok"])) }));
  writeFile(
    root,
    "README.md",
    ["# fixture", "not production custody", ...requiredReadmeSections, overrides.readmeExtra ?? ""].join("\n")
  );
  writeFile(root, ".env.example", requiredEnvVars.map(envVar => (envVar === "AGENTCASH_ARGS" ? envLine.trimEnd() : `${envVar}=`)).join("\n"));
  writeFile(root, "src/config.ts", 'AGENTCASH_ARGS: z.string().default("agentcash@0.14.3")\n');
  writeFile(root, "docker-compose.yml", overrides.defaultCompose ?? "services:\n  postgres:\n    image: postgres:16-alpine\n    profiles: [\"postgres-scaffold\"]\n");
  writeFile(root, "docker-compose.demo.yml", "services:\n  app:\n    environment:\n      NODE_ENV: development\n      DATABASE_PROVIDER: sqlite\n");
  writeFile(
    root,
    "docker-compose.prod-skeleton.yml",
    overrides.prodSkeletonCompose ??
      "# Production skeleton only. This is not custody-ready and is not a runnable production claim.\nservices:\n  app:\n    environment:\n      NODE_ENV: production\n      DATABASE_PROVIDER: postgres\n"
  );

  for (const doc of requiredDocs) {
    writeFile(root, doc, "pinned AgentCash CLI fixture\n");
  }

  for (const template of requiredTemplates) {
    writeFile(root, template, "template\n");
  }

  writeFile(
    root,
    ".release/validation.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        gitCommit: "fixture-commit",
        checks: ["format", "lint", "typecheck", "test", "build", "smoke:dry"].map(name => ({
          name,
          status: "passed"
        }))
      },
      null,
      2
    )
  );

  return root;
}

function writeFile(root: string, relativePath: string, text: string): void {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text);
}
