import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { decryptSecret, encryptSecret, hashTelegramId } from "../src/lib/crypto.js";

describe("config", () => {
  it("parses agentcash args into an array", () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.AGENTCASH_ARGS = "@latest agentcash";
    process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

    const config = getConfig();

    expect(config.agentcashArgs).toEqual(["@latest", "agentcash"]);
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
