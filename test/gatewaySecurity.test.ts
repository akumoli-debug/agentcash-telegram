import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatePolicy, PRIVATE_WALLET_COMMANDS_TELEGRAM } from "../src/gateway/securityPolicy.js";
import type { PolicyInput, SecurityPolicyConfig } from "../src/gateway/securityPolicy.js";
import { buildSecurityPolicyConfig } from "../src/gateway/buildPolicyConfig.js";
import { generatePairingCode, issuePairingCode } from "../src/gateway/pairingStore.js";
import { detectTelegramMention } from "../src/bot.js";
import { AppDatabase } from "../src/db/client.js";
import type { AppConfig } from "../src/config.js";

const MASTER_KEY = Buffer.alloc(32, 77).toString("base64");

const KNOWN_ACTOR_HASH = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_ACTOR_HASH = "bbbbbbbbbbbbbbbbbbbbbbbb";
const CHAT_HASH = "cccccccccccccccccccccccc";

function makePolicy(overrides: Partial<SecurityPolicyConfig> = {}): SecurityPolicyConfig {
  return {
    allowAllUsers: false,
    allowedActorHashes: new Set([KNOWN_ACTOR_HASH]),
    pairingMode: "disabled",
    telegramGroupRequireMention: true,
    discordGuildRequireMention: true,
    freeResponseChatIdHashes: new Set(),
    ...overrides
  };
}

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    platform: "telegram",
    actorIdHash: KNOWN_ACTOR_HASH,
    chatIdHash: CHAT_HASH,
    chatType: "private",
    isCommand: true,
    commandName: "balance",
    botWasMentioned: false,
    messageAuthorIsBot: false,
    walletScopeRequested: "user",
    isCallbackQuery: false,
    ...overrides
  };
}

// --- Pure policy evaluation ---

describe("evaluatePolicy — bot self-message", () => {
  it("silently drops bot-authored messages regardless of all other factors", () => {
    const decision = evaluatePolicy(
      makeInput({ messageAuthorIsBot: true, actorIdHash: KNOWN_ACTOR_HASH }),
      makePolicy()
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("silently drops bot-authored messages even if allowAllUsers=true", () => {
    const decision = evaluatePolicy(
      makeInput({ messageAuthorIsBot: true }),
      makePolicy({ allowAllUsers: true })
    );
    expect(decision.result).toBe("deny_silent");
  });
});

describe("evaluatePolicy — callback query pass-through", () => {
  it("always allows callback queries (approve/cancel buttons verified at handler level)", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, isCallbackQuery: true }),
      makePolicy()
    );
    expect(decision.result).toBe("allow");
  });

  it("allows callback query even with pairingMode=dm_code and unknown actor", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, isCallbackQuery: true }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("allow");
  });
});

describe("evaluatePolicy — allowlist gate", () => {
  it("denies unknown user by default (deny_with_allowlist_message)", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH }),
      makePolicy()
    );
    expect(decision.result).toBe("deny_with_allowlist_message");
  });

  it("allows known user in private chat", () => {
    const decision = evaluatePolicy(makeInput(), makePolicy());
    expect(decision.result).toBe("allow");
  });

  it("allows any user when allowAllUsers=true", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH }),
      makePolicy({ allowAllUsers: true })
    );
    expect(decision.result).toBe("allow");
  });

  it("allows multiple actors in the allowlist", () => {
    const policy = makePolicy({ allowedActorHashes: new Set(["aaa", "bbb", "ccc"]) });
    for (const hash of ["aaa", "bbb", "ccc"]) {
      expect(evaluatePolicy(makeInput({ actorIdHash: hash }), policy).result).toBe("allow");
    }
  });

  it("denies actors not in the allowlist even if close to a listed hash", () => {
    const policy = makePolicy({ allowedActorHashes: new Set(["aaa"]) });
    expect(evaluatePolicy(makeInput({ actorIdHash: "aaab" }), policy).result).toBe("deny_with_allowlist_message");
  });
});

describe("evaluatePolicy — pairing mode", () => {
  it("issues require_pairing in private chat for unknown actor when pairingMode=dm_code", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "private" }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("require_pairing");
  });

  it("silently drops unknown actor in group when pairingMode=dm_code (never send code to group)", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "group" }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("silently drops unknown actor in guild when pairingMode=dm_code", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "guild", platform: "discord" }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("silently drops unknown actor in channel when pairingMode=dm_code", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "channel" }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("known actor is never asked to pair", () => {
    const decision = evaluatePolicy(
      makeInput({ actorIdHash: KNOWN_ACTOR_HASH }),
      makePolicy({ pairingMode: "dm_code" })
    );
    expect(decision.result).toBe("allow");
  });
});

describe("evaluatePolicy — private wallet command guards (Telegram)", () => {
  for (const cmd of PRIVATE_WALLET_COMMANDS_TELEGRAM) {
    it(`/${cmd} in group returns deny_with_dm_instruction`, () => {
      const decision = evaluatePolicy(
        makeInput({ chatType: "group", isCommand: true, commandName: cmd }),
        makePolicy()
      );
      expect(decision.result).toBe("deny_with_dm_instruction");
    });

    it(`/${cmd} in supergroup (mapped to group) returns deny_with_dm_instruction`, () => {
      const decision = evaluatePolicy(
        makeInput({ chatType: "group", isCommand: true, commandName: cmd }),
        makePolicy()
      );
      expect(decision.result).toBe("deny_with_dm_instruction");
    });

    it(`/${cmd} in private chat is allowed for known user`, () => {
      const decision = evaluatePolicy(
        makeInput({ chatType: "private", isCommand: true, commandName: cmd }),
        makePolicy()
      );
      expect(decision.result).toBe("allow");
    });
  }

  it("groupwallet in group is allowed for known user", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: true, commandName: "groupwallet" }),
      makePolicy()
    );
    expect(decision.result).toBe("allow");
  });

  it("freeze in group is allowed for known user (admin-scoped command, not a wallet data command)", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: true, commandName: "freeze" }),
      makePolicy()
    );
    expect(decision.result).toBe("allow");
  });
});

describe("evaluatePolicy — group require-mention", () => {
  it("silently drops plain group text if bot not mentioned (Telegram)", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: false, commandName: undefined, botWasMentioned: false }),
      makePolicy({ telegramGroupRequireMention: true })
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("allows plain group text if bot is mentioned (Telegram)", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: false, commandName: undefined, botWasMentioned: true }),
      makePolicy({ telegramGroupRequireMention: true })
    );
    expect(decision.result).toBe("allow");
  });

  it("slash commands in groups always pass the mention check", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: true, commandName: "groupwallet", botWasMentioned: false }),
      makePolicy({ telegramGroupRequireMention: true })
    );
    expect(decision.result).toBe("allow");
  });

  it("allows group text when telegramGroupRequireMention=false even without mention", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", isCommand: false, commandName: undefined, botWasMentioned: false }),
      makePolicy({ telegramGroupRequireMention: false })
    );
    expect(decision.result).toBe("allow");
  });

  it("allows group text for free-response bypass chat even without mention", () => {
    const decision = evaluatePolicy(
      makeInput({ chatType: "group", chatIdHash: CHAT_HASH, isCommand: false, commandName: undefined, botWasMentioned: false }),
      makePolicy({ telegramGroupRequireMention: true, freeResponseChatIdHashes: new Set([CHAT_HASH]) })
    );
    expect(decision.result).toBe("allow");
  });

  it("silently drops Discord guild natural language if bot not mentioned", () => {
    const decision = evaluatePolicy(
      makeInput({ platform: "discord", chatType: "guild", isCommand: false, commandName: undefined, botWasMentioned: false }),
      makePolicy({ discordGuildRequireMention: true })
    );
    expect(decision.result).toBe("deny_silent");
  });

  it("Discord slash commands pass mention check", () => {
    const decision = evaluatePolicy(
      makeInput({ platform: "discord", chatType: "guild", isCommand: true, commandName: "ac", botWasMentioned: false }),
      makePolicy({ discordGuildRequireMention: true })
    );
    expect(decision.result).toBe("allow");
  });
});

// --- buildSecurityPolicyConfig ---

describe("buildSecurityPolicyConfig", () => {
  function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      TELEGRAM_BOT_TOKEN: "test",
      MASTER_ENCRYPTION_KEY: MASTER_KEY,
      GATEWAY_ALLOWED_USERS: "",
      TELEGRAM_ALLOWED_USERS: "",
      DISCORD_ALLOWED_USERS: "",
      GATEWAY_ALLOW_ALL_USERS: false,
      PAIRING_MODE: "disabled",
      PAIRING_CODE_TTL_SECONDS: 3600,
      TELEGRAM_GROUP_REQUIRE_MENTION: true,
      DISCORD_GUILD_REQUIRE_MENTION: true,
      GROUP_FREE_RESPONSE_CHAT_IDS: "",
      DATABASE_PROVIDER: "sqlite",
      DATABASE_PATH: ":memory:",
      ALLOW_SQLITE_IN_PRODUCTION: false,
      LOCK_PROVIDER: "local",
      ALLOW_LOCAL_LOCKS_IN_PRODUCTION: false,
      AUDIT_SINK: "database",
      AUDIT_STRICT_MODE: false,
      AUDIT_FILE_PATH: "/tmp/audit.jsonl",
      ALLOW_DATABASE_AUDIT_IN_PRODUCTION: false,
      LOG_LEVEL: "silent" as const,
      ALLOW_VERBOSE_LOGS_IN_PRODUCTION: false,
      NODE_ENV: "test" as const,
      BOT_MODE: "polling" as const,
      WEBHOOK_PATH: "/tg",
      WEBHOOK_HOST: "0.0.0.0",
      WEBHOOK_PORT: 3000,
      HEALTH_HOST: "0.0.0.0",
      HEALTH_PORT: 3001,
      AGENTCASH_COMMAND: "npx",
      AGENTCASH_ARGS: "agentcash@0.14.3",
      agentcashArgs: ["agentcash@0.14.3"],
      AGENTCASH_TIMEOUT_MS: 5000,
      DEFAULT_SPEND_CAP_USDC: 0.5,
      HARD_SPEND_CAP_USDC: 5,
      ALLOW_HIGH_VALUE_CALLS: false,
      ALLOW_UNQUOTED_DEV_CALLS: false,
      SKIP_AGENTCASH_HEALTHCHECK: true,
      CUSTODY_MODE: "local_cli" as const,
      ALLOW_INSECURE_LOCAL_CUSTODY: false,
      PENDING_CONFIRMATION_TTL_SECONDS: 300,
      RATE_LIMIT_MAX_PER_MINUTE: 30,
      RATE_LIMIT_MAX_PER_HOUR: 100,
      RATE_LIMIT_QUOTE_MAX_PER_MINUTE: 8,
      RATE_LIMIT_PAID_EXECUTION_MAX_PER_MINUTE: 3,
      RATE_LIMIT_REPLAY_MAX_PER_HOUR: 10,
      GLOBAL_PAID_CALL_CONCURRENCY: 4,
      GROUP_DAILY_CAP_USDC: 25,
      AGENTCASH_HOME_ROOT: "/tmp/agentcash-homes",
      OPENAI_ROUTER_MODEL: "gpt-4o-mini",
      ANTHROPIC_ROUTER_MODEL: "claude-haiku-4-5",
      ROUTER_CONFIDENCE_THRESHOLD: 0.75,
      ROUTER_TIMEOUT_MS: 5000,
      ...overrides
    } as AppConfig;
  }

  it("defaults to secure: no allowed actors, pairing disabled", () => {
    const policyConfig = buildSecurityPolicyConfig(makeAppConfig());
    expect(policyConfig.allowAllUsers).toBe(false);
    expect(policyConfig.allowedActorHashes.size).toBe(0);
    expect(policyConfig.pairingMode).toBe("disabled");
    expect(policyConfig.telegramGroupRequireMention).toBe(true);
    expect(policyConfig.discordGuildRequireMention).toBe(true);
  });

  it("GATEWAY_ALLOW_ALL_USERS=true sets allowAllUsers", () => {
    const policyConfig = buildSecurityPolicyConfig(makeAppConfig({ GATEWAY_ALLOW_ALL_USERS: true }));
    expect(policyConfig.allowAllUsers).toBe(true);
  });

  it("hashes TELEGRAM_ALLOWED_USERS at startup", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ TELEGRAM_ALLOWED_USERS: "123456789" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(1);
    // Verify the hash is present (not the raw ID).
    expect([...policyConfig.allowedActorHashes][0]).not.toBe("123456789");
    expect([...policyConfig.allowedActorHashes][0]!.length).toBe(24);
  });

  it("handles comma-separated TELEGRAM_ALLOWED_USERS", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ TELEGRAM_ALLOWED_USERS: "111,222,333" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(3);
  });

  it("hashes DISCORD_ALLOWED_USERS with discord: prefix", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ DISCORD_ALLOWED_USERS: "987654321" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(1);
    expect([...policyConfig.allowedActorHashes][0]!.length).toBe(24);
  });

  it("handles tg: prefix in GATEWAY_ALLOWED_USERS", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ GATEWAY_ALLOWED_USERS: "tg:111111" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(1);
  });

  it("handles dc: prefix in GATEWAY_ALLOWED_USERS", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ GATEWAY_ALLOWED_USERS: "dc:222222" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(1);
  });

  it("unknown prefix in GATEWAY_ALLOWED_USERS is silently ignored", () => {
    const policyConfig = buildSecurityPolicyConfig(
      makeAppConfig({ GATEWAY_ALLOWED_USERS: "xx:unknown" })
    );
    expect(policyConfig.allowedActorHashes.size).toBe(0);
  });
});

// --- Pairing store ---

describe("pairing store — generatePairingCode", () => {
  it("returns an 8-char uppercase hex code and its SHA-256 hash", () => {
    const { code, codeHash } = generatePairingCode();
    expect(code).toMatch(/^[0-9A-F]{8}$/);
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique codes each call", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode().code));
    expect(codes.size).toBeGreaterThan(15);
  });
});

describe("pairing store — issuePairingCode", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("creates a pending pairing code in the DB", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    const { code } = issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    expect(code).toMatch(/^[0-9A-F]{8}$/);

    const row = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH);
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
  });

  it("expires existing pending codes when a new one is issued", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    const first = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH);

    issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    const second = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH);

    expect(first?.id).not.toBe(second?.id);
    // The old code should be expired.
    const old = db.sqlite
      .prepare("SELECT status FROM gateway_pairing_codes WHERE id = ?")
      .get(first!.id) as { status: string };
    expect(old.status).toBe("expired");
  });
});

// --- DB pairing methods ---

describe("AppDatabase — pairing code methods", () => {
  let db: AppDatabase;

  afterEach(() => db?.close());

  it("approvePairingCode transitions status to approved", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    const { code } = issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    const row = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH)!;

    const approved = db.approvePairingCode(row.id);
    expect(approved).toBe(true);

    const updated = db.sqlite
      .prepare("SELECT status FROM gateway_pairing_codes WHERE id = ?")
      .get(row.id) as { status: string };
    expect(updated.status).toBe("approved");
    void code;
  });

  it("approvePairingCode returns false for expired or non-existent code", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    const result = db.approvePairingCode("nonexistent-id");
    expect(result).toBe(false);
  });

  it("revokeActorPairingCodes revokes all active codes for that actor", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    const row = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH)!;
    db.approvePairingCode(row.id);

    const revoked = db.revokeActorPairingCodes("telegram", KNOWN_ACTOR_HASH);
    expect(revoked).toBeGreaterThan(0);

    const check = db.sqlite
      .prepare("SELECT status FROM gateway_pairing_codes WHERE id = ?")
      .get(row.id) as { status: string };
    expect(check.status).toBe("revoked");
  });

  it("listApprovedPairingActors returns approved actor hashes", () => {
    db = new AppDatabase(":memory:");
    db.initialize();

    issuePairingCode(db, "telegram", KNOWN_ACTOR_HASH, 3600);
    const row = db.getPendingPairingCode("telegram", KNOWN_ACTOR_HASH)!;
    db.approvePairingCode(row.id);

    const actors = db.listApprovedPairingActors("telegram");
    expect(actors).toContain(KNOWN_ACTOR_HASH);
  });
});

// --- detectTelegramMention helper ---

describe("detectTelegramMention", () => {
  it("detects @botname mention", () => {
    expect(detectTelegramMention("Hey @mybot help", "mybot")).toBe(true);
  });

  it("detects @botname mention case-insensitively for generic bot regex", () => {
    expect(detectTelegramMention("Hey @AgentCashBot help", undefined)).toBe(true);
  });

  it("returns false for plain text without mention", () => {
    expect(detectTelegramMention("what is the research result?", "mybot")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(detectTelegramMention("", "mybot")).toBe(false);
  });

  it("matches @mention even when botUsername is undefined", () => {
    expect(detectTelegramMention("@CoolBot do something", undefined)).toBe(true);
  });
});

// --- Integration: policy decisions map to expected outputs ---

describe("policy decision surface — behavior table", () => {
  const restrictivePolicy = makePolicy({
    allowAllUsers: false,
    allowedActorHashes: new Set([KNOWN_ACTOR_HASH]),
    pairingMode: "disabled",
    telegramGroupRequireMention: true,
    discordGuildRequireMention: true
  });

  const cases: Array<{
    label: string;
    input: PolicyInput;
    expectedResult: string;
  }> = [
    {
      label: "unknown user — denied by default",
      input: makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "private" }),
      expectedResult: "deny_with_allowlist_message"
    },
    {
      label: "known user — private wallet command in private — allowed",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "private", commandName: "balance" }),
      expectedResult: "allow"
    },
    {
      label: "known user — /start in group — deny with DM instruction",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", commandName: "start" }),
      expectedResult: "deny_with_dm_instruction"
    },
    {
      label: "known user — /deposit in group — deny with DM instruction",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", commandName: "deposit" }),
      expectedResult: "deny_with_dm_instruction"
    },
    {
      label: "known user — /balance in group — deny with DM instruction",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", commandName: "balance" }),
      expectedResult: "deny_with_dm_instruction"
    },
    {
      label: "known user — /history in group — deny with DM instruction",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", commandName: "history" }),
      expectedResult: "deny_with_dm_instruction"
    },
    {
      label: "known user — natural language in group without mention — deny silent",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", isCommand: false, commandName: undefined, botWasMentioned: false }),
      expectedResult: "deny_silent"
    },
    {
      label: "known user — natural language in group with mention — allowed",
      input: makeInput({ actorIdHash: KNOWN_ACTOR_HASH, chatType: "group", isCommand: false, commandName: undefined, botWasMentioned: true }),
      expectedResult: "allow"
    },
    {
      label: "bot self-message — always deny silent",
      input: makeInput({ messageAuthorIsBot: true }),
      expectedResult: "deny_silent"
    },
    {
      label: "callback query from unknown actor — always allow (handler validates ownership)",
      input: makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, isCallbackQuery: true }),
      expectedResult: "allow"
    },
    {
      label: "unknown actor in group with pairing=dm_code — silent drop (no code in group)",
      input: makeInput({ actorIdHash: UNKNOWN_ACTOR_HASH, chatType: "group" }),
      expectedResult: "deny_with_allowlist_message"
    },
    {
      label: "Discord guild slash command — passes mention check",
      input: makeInput({ platform: "discord", chatType: "guild", isCommand: true, commandName: "ac", botWasMentioned: false }),
      expectedResult: "allow"
    }
  ];

  for (const { label, input, expectedResult } of cases) {
    it(label, () => {
      const decision = evaluatePolicy(input, restrictivePolicy);
      expect(decision.result).toBe(expectedResult);
    });
  }
});
