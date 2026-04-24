import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { ConfigError } from "../src/lib/errors.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, originalEnv);
});

describe("security config", () => {
  it("requires a webhook domain in webhook mode", () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.BOT_MODE = "webhook";
    delete process.env.WEBHOOK_DOMAIN;

    expect(() => getConfig()).toThrowError(ConfigError);
  });

  it("exposes secure rate limit defaults", () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");

    const config = getConfig();

    expect(config.RATE_LIMIT_MAX_PER_MINUTE).toBe(30);
    expect(config.RATE_LIMIT_MAX_PER_HOUR).toBe(100);
  });
});
