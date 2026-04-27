import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getConfig, parseConfig } from "../src/config.js";
import { assertRuntimeDatabaseAdapterImplemented } from "../src/db/DatabaseAdapter.js";
import { decryptSecret, encryptSecret, hashTelegramId } from "../src/lib/crypto.js";
import { startHealthServer } from "../src/healthServer.js";
import type { AppConfig } from "../src/config.js";
import type { AppLogger } from "../src/lib/logger.js";

const execFileAsync = promisify(execFile);
const MASTER_KEY = Buffer.alloc(32, 1).toString("base64");

const silentLogger: AppLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger
} as unknown as AppLogger;

describe("config", () => {
  it("parses agentcash args into an array", () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.AGENTCASH_ARGS = "agentcash@0.14.3 --verbose";
    process.env.MASTER_ENCRYPTION_KEY = MASTER_KEY;

    const config = getConfig();

    expect(config.agentcashArgs).toEqual(["agentcash@0.14.3", "--verbose"]);
  });

  it("allows development @latest with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = parseConfig({
      NODE_ENV: "development",
      TELEGRAM_BOT_TOKEN: "test-token",
      AGENTCASH_ARGS: "agentcash@latest",
      MASTER_ENCRYPTION_KEY: MASTER_KEY
    });

    expect(config.agentcashArgs).toEqual(["agentcash@latest"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("allowed only for development"));
    warn.mockRestore();
  });

  it("rejects @latest in production", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        AGENTCASH_ARGS: "agentcash@latest",
        MASTER_ENCRYPTION_KEY: MASTER_KEY,
        ALLOW_INSECURE_LOCAL_CUSTODY: "true",
        ALLOW_SQLITE_IN_PRODUCTION: "true",
        ALLOW_LOCAL_LOCKS_IN_PRODUCTION: "true",
        HARD_SPEND_CAP_USDC: "5",
        AUDIT_SINK: "file"
      })
    ).toThrow(/AGENTCASH_ARGS must pin/);
  });

  it("fails clearly when Postgres runtime adapter is selected", () => {
    const config = parseConfig({
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "test-token",
      DATABASE_PROVIDER: "postgres",
      DATABASE_URL: "postgres://example.invalid/db",
      MASTER_ENCRYPTION_KEY: MASTER_KEY
    });

    expect(() => assertRuntimeDatabaseAdapterImplemented(config)).toThrow(
      "Postgres runtime adapter is not implemented yet. Use SQLite for local demo or implement PostgresAdapter before production."
    );
  });

  it("fails clearly when neither Telegram nor Discord bot token is set", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "test",
        MASTER_ENCRYPTION_KEY: MASTER_KEY
      })
    ).toThrow(/At least one bot token is required/);
  });

  it("does not allow production to skip the AgentCash CLI health check", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "test-token",
        MASTER_ENCRYPTION_KEY: MASTER_KEY,
        SKIP_AGENTCASH_HEALTHCHECK: "true",
        ALLOW_INSECURE_LOCAL_CUSTODY: "true",
        ALLOW_SQLITE_IN_PRODUCTION: "true",
        ALLOW_LOCAL_LOCKS_IN_PRODUCTION: "true",
        HARD_SPEND_CAP_USDC: "5",
        AUDIT_SINK: "file"
      })
    ).toThrow(/SKIP_AGENTCASH_HEALTHCHECK must be false/);
  });
});

describe("health server", () => {
  it("starts and closes cleanly", async () => {
    const config = parseConfig({
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "test-token",
      MASTER_ENCRYPTION_KEY: MASTER_KEY,
      HEALTH_HOST: "127.0.0.1",
      HEALTH_PORT: "0"
    });
    const server = startHealthServer(config as AppConfig, silentLogger);

    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    expect(address).toMatchObject({ port: expect.any(Number) });

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      if (!address || typeof address === "string") {
        reject(new Error("missing health server address"));
        return;
      }

      const req = http.get(
        { host: address.address, port: address.port, path: "/healthz" },
        res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );

      req.on("error", reject);
    });

    expect(statusCode).toBe(200);

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("healthz stays alive while readyz reports dependency failure", async () => {
    const config = parseConfig({
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "test-token",
      MASTER_ENCRYPTION_KEY: MASTER_KEY,
      HEALTH_HOST: "127.0.0.1",
      HEALTH_PORT: "0"
    });
    const server = startHealthServer(config as AppConfig, silentLogger, [
      { name: "db", check: () => { throw new Error("db unavailable"); } }
    ]);

    await new Promise<void>(resolve => server.once("listening", resolve));
    const health = await requestStatus(server, "/healthz");
    const ready = await requestStatus(server, "/readyz");
    expect(health).toBe(200);
    expect(ready).toBe(503);

    await closeServer(server);
  });

  it("readyz fails if signer health fails", async () => {
    const config = parseConfig({
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "test-token",
      MASTER_ENCRYPTION_KEY: MASTER_KEY,
      HEALTH_HOST: "127.0.0.1",
      HEALTH_PORT: "0"
    });
    const server = startHealthServer(config as AppConfig, silentLogger, [
      { name: "custody", check: async () => { throw new Error("signer unavailable"); } }
    ]);

    await new Promise<void>(resolve => server.once("listening", resolve));
    await expect(requestStatus(server, "/healthz")).resolves.toBe(200);
    await expect(requestStatus(server, "/readyz")).resolves.toBe(503);

    await closeServer(server);
  });
});

async function requestStatus(server: import("node:http").Server, path: string): Promise<number | undefined> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing health server address");
  }

  return await new Promise<number | undefined>((resolve, reject) => {
    const req = http.get(
      { host: address.address, port: address.port, path },
      res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );

    req.on("error", reject);
  });
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("live smoke harness", () => {
  it("dry-run does not require real Telegram or Discord tokens", async () => {
    const env = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      DISCORD_APPLICATION_ID: "",
      MASTER_ENCRYPTION_KEY: "",
      SKIP_AGENTCASH_HEALTHCHECK: "true"
    };

    const result = await execFileAsync(
      "corepack",
      ["pnpm", "tsx", "scripts/smoke-live.ts", "--dry-run", "--telegram", "--discord"],
      { cwd: process.cwd(), env, timeout: 30_000 }
    );

    expect(result.stderr).toContain("dry-run smoke complete");
  });
});

describe("crypto helpers", () => {
  it("encrypts and decrypts secrets", () => {
    const masterKey = Buffer.alloc(32, 2).toString("base64");
    const encrypted = encryptSecret("top-secret", masterKey);

    expect(encrypted).not.toContain("top-secret");
    expect(decryptSecret(encrypted, masterKey)).toBe("top-secret");
  });

  it("hashes telegram ids without exposing the raw id", () => {
    const masterKey = Buffer.alloc(32, 3).toString("base64");
    const hashed = hashTelegramId("123456789", masterKey);

    expect(hashed).toHaveLength(24);
    expect(hashed).not.toContain("123456789");
  });
});
