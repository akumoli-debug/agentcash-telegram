import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AgentCashClient } from "../src/agentcash/agentcashClient.js";
import type { AppConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { KmsSigner } from "../src/custody/kmsSigner.js";
import { LocalCliSigner } from "../src/custody/localCliSigner.js";
import type { Signer } from "../src/custody/signer.js";
import { AppDatabase, type WalletRow } from "../src/db/client.js";
import { encryptSecret } from "../src/lib/crypto.js";

const MASTER_KEY = Buffer.alloc(32, 88).toString("base64");

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent" as const,
    NODE_ENV: "test" as const,
    BOT_MODE: "polling" as const,
    WEBHOOK_PATH: "/tg",
    WEBHOOK_HOST: "0.0.0.0",
    WEBHOOK_PORT: 3000,
    HEALTH_HOST: "127.0.0.1",
    HEALTH_PORT: 0,
    AGENTCASH_COMMAND: "agentcash",
    AGENTCASH_ARGS: "agentcash@latest",
    agentcashArgs: ["agentcash@latest"],
    AGENTCASH_TIMEOUT_MS: 5000,
    DEFAULT_SPEND_CAP_USDC: 0.5,
    HARD_SPEND_CAP_USDC: 5,
    ALLOW_HIGH_VALUE_CALLS: false,
    ALLOW_UNQUOTED_DEV_CALLS: false,
    SKIP_AGENTCASH_HEALTHCHECK: false,
    CUSTODY_MODE: "local_cli" as const,
    ALLOW_INSECURE_LOCAL_CUSTODY: false,
    PENDING_CONFIRMATION_TTL_SECONDS: 300,
    RATE_LIMIT_MAX_PER_MINUTE: 100,
    RATE_LIMIT_MAX_PER_HOUR: 1000,
    AGENTCASH_HOME_ROOT: "/tmp/agentcash-test",
    OPENAI_ROUTER_MODEL: "gpt-4o-mini",
    ANTHROPIC_ROUTER_MODEL: "claude-haiku-4-5-20251001",
    ROUTER_CONFIDENCE_THRESHOLD: 0.75,
    ROUTER_TIMEOUT_MS: 5000,
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
    ...overrides
  } as AppConfig;
}

function makeWalletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: "wal_test",
    kind: "user",
    owner_user_id: "usr_test",
    owner_group_id: null,
    home_dir_hash: "home-hash",
    address: "0xABCDEF1234567890",
    network: "base",
    deposit_link: null,
    wallet_ref: "home-hash",
    signer_backend: "local_cli",
    public_address: "0xABCDEF1234567890",
    active_key_version: 1,
    encrypted_private_key: null,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

describe("custody config guards", () => {
  it("production rejects local_cli custody without an explicit unsafe override", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        MASTER_ENCRYPTION_KEY: MASTER_KEY,
        CUSTODY_MODE: "local_cli",
        ALLOW_SQLITE_IN_PRODUCTION: "true",
        ALLOW_LOCAL_LOCKS_IN_PRODUCTION: "true",
        HARD_SPEND_CAP_USDC: "5",
        AUDIT_SINK: "file"
      })
    ).toThrow(/CUSTODY_MODE=local_cli is demo-only/);
  });

  it("production allows local_cli only with the explicit unsafe override", () => {
    const config = parseConfig({
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "test-token",
      MASTER_ENCRYPTION_KEY: MASTER_KEY,
      CUSTODY_MODE: "local_cli",
      ALLOW_INSECURE_LOCAL_CUSTODY: "true",
      ALLOW_SQLITE_IN_PRODUCTION: "true",
      ALLOW_LOCAL_LOCKS_IN_PRODUCTION: "true",
      HARD_SPEND_CAP_USDC: "5",
      AUDIT_SINK: "file"
    });

    expect(config.ALLOW_INSECURE_LOCAL_CUSTODY).toBe(true);
  });

  it("production rejects the documented placeholder master key", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        MASTER_ENCRYPTION_KEY: "replace-with-32-byte-base64-key",
        CUSTODY_MODE: "remote_signer",
        REMOTE_SIGNER_URL: "https://signer.example",
        DATABASE_PROVIDER: "postgres",
        DATABASE_URL: "postgres://example.invalid/db",
        LOCK_PROVIDER: "redis",
        REDIS_URL: "redis://localhost:6379"
      })
    ).toThrow(/MASTER_ENCRYPTION_KEY/);
  });
});

describe("signer boundary", () => {
  it("local_cli signer health check calls the configured health runner", async () => {
    const healthRunner = vi.fn().mockResolvedValue(undefined);
    const signer = new LocalCliSigner(makeConfig(), healthRunner);

    await expect(signer.healthCheck()).resolves.toMatchObject({ ok: true, mode: "local_cli" });
    expect(healthRunner).toHaveBeenCalledTimes(1);
  });

  it("KMS mode fails with a clear error instead of falling back", async () => {
    const signer = new KmsSigner(makeConfig({ CUSTODY_MODE: "kms" }));

    await expect(signer.healthCheck()).rejects.toThrow(/not implemented yet/);
  });

  it("the signer interface can be mocked in tests", async () => {
    const signer: Signer = {
      getAddress: vi.fn().mockResolvedValue("0xMOCK"),
      signPaymentRequest: vi.fn().mockResolvedValue({
        walletRef: { walletId: "wal_test", walletRef: "ref", signerBackend: "remote_signer" },
        signerBackend: "remote_signer",
        signedRequest: { ok: true }
      }),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, mode: "remote_signer" })
    };

    await expect(signer.getAddress({ walletId: "wal_test", walletRef: "ref", signerBackend: "remote_signer" }))
      .resolves.toBe("0xMOCK");
  });

  it("SkillExecutor does not import custody key decrypt helpers", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "agentcash", "skillExecutor.ts"),
      "utf8"
    );

    expect(source).not.toContain("decryptSecret");
    expect(source).not.toContain("encrypted_private_key");
  });

  it("fake private keys do not appear in AgentCash command errors", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentcash-custody-test-"));
    const scriptPath = path.join(tempDir, "fail-with-secret.js");
    const fakePrivateKey = "0xFAKE_PRIVATE_KEY_SHOULD_NOT_LEAK";

    fs.writeFileSync(
      scriptPath,
      "process.stderr.write(String(process.env.X402_PRIVATE_KEY)); process.stdout.write(String(process.env.X402_PRIVATE_KEY)); process.exit(2);"
    );

    try {
      const config = makeConfig({
        AGENTCASH_COMMAND: process.execPath,
        AGENTCASH_ARGS: scriptPath,
        agentcashArgs: [scriptPath],
        AGENTCASH_HOME_ROOT: tempDir,
        AGENTCASH_TIMEOUT_MS: 5000
      });
      const wallet = makeWalletRow({
        encrypted_private_key: encryptSecret(fakePrivateKey, config.MASTER_ENCRYPTION_KEY)
      });
      const client = new AgentCashClient(config);

      await expect(client.getBalance(wallet)).rejects.toThrow(/AgentCash command failed/);
      await client.getBalance(wallet).catch(error => {
        expect(JSON.stringify(error)).not.toContain(fakePrivateKey);
        expect(error.message).not.toContain(fakePrivateKey);
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("key rotation records", () => {
  it("local demo key rotation writes an audit event and keeps the old key deprecated", () => {
    const db = new AppDatabase(":memory:");
    db.initialize();

    const user = db.upsertUser({ telegramUserId: "123", defaultSpendCapUsdc: 0.5 });
    const wallet = db.createUserWallet(user.id, {
      homeDirHash: "home-hash",
      address: "0xOLD",
      publicAddress: "0xOLD",
      encryptedPrivateKey: "encrypted-old",
      signerBackend: "local_cli",
      activeKeyVersion: 1,
      status: "active"
    });

    const rotated = db.rotateLocalDemoWalletKey({
      walletId: wallet.id,
      encryptedPrivateKey: "encrypted-new",
      publicAddress: "0xNEW",
      actorHash: "actor-hash"
    });

    const audit = db.sqlite
      .prepare("SELECT * FROM audit_events WHERE event_name = 'key_rotated'")
      .get() as { metadata_json: string } | undefined;
    const deprecated = db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM key_versions WHERE wallet_id = ? AND status = 'deprecated'")
      .get(wallet.id) as { count: number };

    expect(rotated.version).toBe(2);
    expect(audit?.metadata_json).toContain("\"migrationRequired\":true");
    expect(deprecated.count).toBe(1);

    db.close();
  });
});
