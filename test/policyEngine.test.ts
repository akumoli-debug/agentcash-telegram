import { describe, it, expect, beforeEach } from "vitest";
import { AppDatabase } from "../src/db/client.js";
import type { AppConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { PolicyEngine, type PolicyEvaluationInput } from "../src/policy/PolicyEngine.js";

const MASTER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64");

function makeConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "test-token",
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
    ...overrides
  });
}

function makeDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.initialize();
  return db;
}

function seedWallet(db: AppDatabase, status: "active" | "disabled" | "pending" = "active") {
  const user = db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 });
  const wallet = db.createUserWallet(user.id, {
    homeDirHash: "home-hash",
    address: "0xABC",
    encryptedPrivateKey: "enc",
    status
  });
  return { user, wallet };
}

function seedGroupWallet(db: AppDatabase) {
  const user = db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 });
  const { group, wallet } = db.createGroupWithWallet({
    telegramChatIdHash: "chat-hash-1",
    createdByUserId: user.id,
    spendCapUsdc: 0.5,
    homeDirHash: "group-home-hash",
    signerBackend: "local_cli"
  });
  return { user, group, wallet };
}

function makeInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    platform: "telegram",
    actorIdHash: "actor-hash",
    walletId: "wal_test",
    walletStatus: "active",
    groupId: null,
    skill: "research",
    endpoint: "https://stableenrich.dev/api/exa/search",
    quotedCostCents: 10,
    isDevUnquoted: false,
    confirmationCapUsdc: undefined,
    groupAdminCapUsdc: undefined,
    ...overrides
  };
}

describe("PolicyEngine", () => {
  let db: AppDatabase;
  let config: AppConfig;
  let engine: PolicyEngine;

  beforeEach(() => {
    db = makeDb();
    config = makeConfig();
    engine = new PolicyEngine(db, config);
  });

  // Scenario 1: under cap — allow
  it("scenario 1: under per-call cap — allows without confirmation", () => {
    const { wallet } = seedWallet(db);
    const decision = engine.evaluate(makeInput({
      walletId: wallet.id,
      quotedCostCents: 10,
      confirmationCapUsdc: 0.50  // 50 cents cap, 10 cent request
    }));
    expect(decision.outcome).toBe("allow");
    expect(decision.policyType).toBe("default");
  });

  // Scenario 2: over per-call cap — require confirmation
  it("scenario 2: over per-call cap — requires confirmation", () => {
    const { wallet } = seedWallet(db);

    // Record a prior transaction so first-spend doesn't fire
    db.createTransaction({
      userId: db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 }).id,
      walletId: wallet.id,
      telegramChatId: "chat-1",
      commandName: "research",
      skill: "research",
      status: "success",
      estimatedCostCents: 5
    });

    const decision = engine.evaluate(makeInput({
      walletId: wallet.id,
      quotedCostCents: 100,     // $1.00
      confirmationCapUsdc: 0.50 // $0.50 cap
    }));
    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.policyType).toBe("per_call_cap");
    expect(decision.requiresGroupAdminApproval).toBe(false);
  });

  // Scenario 3: over daily cap — denied
  it("scenario 3: over daily wallet cap — denies with daily_cap outcome", () => {
    const { wallet } = seedWallet(db);
    const engineWithCap = new PolicyEngine(db, makeConfig({ POLICY_DAILY_CAP_USDC: "0.50" }));

    // Spend 45 cents already
    db.createTransaction({
      userId: db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 }).id,
      walletId: wallet.id,
      telegramChatId: "chat-1",
      commandName: "research",
      skill: "research",
      status: "success",
      estimatedCostCents: 45
    });

    // 10 cent request would bring total to 55 cents, over 50-cent cap
    const decision = engineWithCap.evaluate(makeInput({
      walletId: wallet.id,
      quotedCostCents: 10
    }));
    expect(decision.outcome).toBe("deny_daily_cap");
    expect(decision.policyType).toBe("daily_wallet_cap");
    expect(decision.capStatusText).toMatch(/\$0\.45 of \$0\.50 daily cap/);
  });

  // Scenario 4: frozen wallet — denied
  it("scenario 4: frozen wallet — deny_frozen", () => {
    const { wallet } = seedWallet(db, "disabled");
    const decision = engine.evaluate(makeInput({
      walletId: wallet.id,
      walletStatus: "disabled"
    }));
    expect(decision.outcome).toBe("deny_frozen");
    expect(decision.policyType).toBe("frozen_wallet");
  });

  // Scenario 5: trusted skill auto-approved
  it("scenario 5: trusted skill auto-approved below threshold", () => {
    const { wallet } = seedWallet(db);
    const engineWithTrusted = new PolicyEngine(
      db,
      makeConfig({
        POLICY_TRUSTED_SKILLS: "research",
        POLICY_TRUSTED_AUTO_APPROVE_MAX_USDC: "0.50"
      })
    );

    const decision = engineWithTrusted.evaluate(makeInput({
      walletId: wallet.id,
      quotedCostCents: 10,            // $0.10 — under $0.50 threshold
      confirmationCapUsdc: 0.05       // would normally require confirmation ($0.10 > $0.05)
    }));
    // Trusted skill auto-approve fires BEFORE per-call cap check
    expect(decision.outcome).toBe("allow");
    expect(decision.policyType).toBe("trusted_skill_auto_approve");
  });

  // Scenario 6: group high-cost requires group admin approval
  it("scenario 6: group over-cap quote requires group admin approval", () => {
    const { group, wallet } = seedGroupWallet(db);
    const decision = engine.evaluate(makeInput({
      walletId: wallet.id,
      walletStatus: "active",
      groupId: group.id,
      quotedCostCents: 100,           // $1.00
      confirmationCapUsdc: 0.50,      // $0.50 group per-call cap
      groupAdminCapUsdc: 0.50         // same — above this admin approval required
    }));
    expect(decision.outcome).toBe("require_group_admin_approval");
    expect(decision.requiresGroupAdminApproval).toBe(true);
  });

  // Scenario 7: policy snapshot immutability — changing policy after quote doesn't alter old snapshot
  it("scenario 7: policy snapshot stored immutably — later policy changes don't overwrite", () => {
    const { wallet } = seedWallet(db);

    const decision = engine.evaluate(makeInput({
      walletId: wallet.id,
      quotedCostCents: 10,
      confirmationCapUsdc: 0.50
    }));

    const snapshotAtDecisionTime = JSON.parse(decision.snapshotJson) as Record<string, unknown>;

    // Create a fake quote and record the decision
    const quote = db.createQuote({
      userHash: "actor-hash",
      walletId: wallet.id,
      skill: "research",
      endpoint: "https://stableenrich.dev/api/exa/search",
      canonicalRequestJson: '{"query":"test"}',
      requestHash: "req-hash",
      quotedCostCents: 10,
      maxApprovedCostCents: 100,
      isDevUnquoted: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    db.recordPolicyDecision(quote.id, wallet.id, "actor-hash", decision);

    // Now change the wallet policy
    db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: 0.01 });

    // The stored decision snapshot should still reflect the OLD policy (no daily cap)
    const stored = db.getPolicyDecision(quote.id)!;
    const storedSnapshot = JSON.parse(stored.snapshot_json) as Record<string, unknown>;
    const storedWalletPolicy = storedSnapshot.walletPolicy as Record<string, unknown> | null;

    expect(storedWalletPolicy).toBeNull(); // no policy existed when quote was created
    expect(snapshotAtDecisionTime).toEqual(storedSnapshot); // snapshot is identical to original
  });

  describe("per-wallet skill allowlist", () => {
    it("blocks skill not in allowlist", () => {
      const { wallet } = seedWallet(db);
      db.upsertWalletPolicy(wallet.id, { skillAllowlist: "enrich" });
      const decision = engine.evaluate(makeInput({ walletId: wallet.id, skill: "research" }));
      expect(decision.outcome).toBe("deny_skill_blocked");
      expect(decision.policyType).toBe("skill_allowlist");
    });

    it("allows skill in allowlist", () => {
      const { wallet } = seedWallet(db);
      db.upsertWalletPolicy(wallet.id, { skillAllowlist: "research,enrich" });
      const decision = engine.evaluate(makeInput({ walletId: wallet.id, skill: "research" }));
      expect(decision.outcome).toBe("allow");
    });
  });

  describe("per-skill block override", () => {
    it("denies explicitly blocked skill", () => {
      const { wallet } = seedWallet(db);
      db.upsertSkillPolicy(wallet.id, "research", "blocked");
      const decision = engine.evaluate(makeInput({ walletId: wallet.id, skill: "research" }));
      expect(decision.outcome).toBe("deny_skill_blocked");
      expect(decision.policyType).toBe("skill_blocked");
    });

    it("allows explicitly allowed skill", () => {
      const { wallet } = seedWallet(db);
      db.upsertSkillPolicy(wallet.id, "research", "allowed");
      const decision = engine.evaluate(makeInput({ walletId: wallet.id, skill: "research" }));
      expect(decision.outcome).toBe("allow");
    });
  });

  describe("weekly cap", () => {
    it("denies when weekly spend would exceed cap", () => {
      const { wallet } = seedWallet(db);
      const engineWithWeekly = new PolicyEngine(db, makeConfig({ POLICY_WEEKLY_CAP_USDC: "0.10" }));

      db.createTransaction({
        userId: db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 }).id,
        walletId: wallet.id,
        telegramChatId: "chat-1",
        commandName: "research",
        skill: "research",
        status: "success",
        estimatedCostCents: 8
      });

      const decision = engineWithWeekly.evaluate(makeInput({
        walletId: wallet.id,
        quotedCostCents: 5 // 8 + 5 = 13 > 10 cents
      }));
      expect(decision.outcome).toBe("deny_weekly_cap");
      expect(decision.capStatusText).toMatch(/\$0\.08 of \$0\.10 weekly cap/);
    });
  });

  describe("hard cap", () => {
    it("denies when quotedCostCents exceeds HARD_SPEND_CAP_USDC", () => {
      const { wallet } = seedWallet(db);
      // Default HARD_SPEND_CAP_USDC=5 ($5.00 = 500 cents)
      const decision = engine.evaluate(makeInput({
        walletId: wallet.id,
        quotedCostCents: 600 // $6.00 — over $5.00 hard cap
      }));
      expect(decision.outcome).toBe("deny_hard_cap");
      expect(decision.policyType).toBe("hard_cap");
    });

    it("allows when ALLOW_HIGH_VALUE_CALLS=true even over hard cap", () => {
      const { wallet } = seedWallet(db);
      const enginePermissive = new PolicyEngine(db, makeConfig({ ALLOW_HIGH_VALUE_CALLS: "true" }));
      const decision = enginePermissive.evaluate(makeInput({
        walletId: wallet.id,
        quotedCostCents: 1000,
        confirmationCapUsdc: 100
      }));
      // Only blocked by confirmationCap (100 USDC cap, 10 dollar request), or allow if no other checks fire
      expect(decision.outcome).not.toBe("deny_hard_cap");
    });
  });

  describe("first spend", () => {
    it("requires confirmation for first spend when POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION=true", () => {
      const { wallet } = seedWallet(db);
      const engineFirstSpend = new PolicyEngine(
        db,
        makeConfig({ POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION: "true" })
      );
      const decision = engineFirstSpend.evaluate(makeInput({ walletId: wallet.id }));
      expect(decision.outcome).toBe("require_confirmation");
      expect(decision.policyType).toBe("first_spend");
    });

    it("allows without first-spend prompt once prior transaction exists", () => {
      const { wallet, user } = seedWallet(db);
      const engineFirstSpend = new PolicyEngine(
        db,
        makeConfig({ POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION: "true" })
      );

      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        telegramChatId: "chat-1",
        commandName: "research",
        skill: "research",
        status: "success",
        estimatedCostCents: 5
      });

      const decision = engineFirstSpend.evaluate(makeInput({ walletId: wallet.id }));
      expect(decision.outcome).toBe("allow");
    });
  });

  describe("high-cost threshold", () => {
    it("requires confirmation when cost exceeds POLICY_HIGH_COST_THRESHOLD_USDC", () => {
      const { wallet } = seedWallet(db);
      const engineHigh = new PolicyEngine(
        db,
        makeConfig({ POLICY_HIGH_COST_THRESHOLD_USDC: "0.05" })
      );
      // Record a prior transaction so first-spend doesn't fire
      db.createTransaction({
        userId: db.upsertUser({ telegramUserId: "tg:999", defaultSpendCapUsdc: 0.5 }).id,
        walletId: wallet.id,
        telegramChatId: "chat-1",
        commandName: "research",
        skill: "research",
        status: "success",
        estimatedCostCents: 1
      });

      const decision = engineHigh.evaluate(makeInput({
        walletId: wallet.id,
        quotedCostCents: 10 // $0.10 > $0.05 threshold
      }));
      expect(decision.outcome).toBe("require_confirmation");
      expect(decision.policyType).toBe("high_cost");
    });
  });

  describe("group daily cap", () => {
    it("denies when group daily cap exceeded", () => {
      const { group, wallet, user } = seedGroupWallet(db);
      // GROUP_DAILY_CAP_USDC defaults to 25 ($25 = 2500 cents)
      const engineGroupCap = new PolicyEngine(db, makeConfig({ GROUP_DAILY_CAP_USDC: "0.10" }));

      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        groupId: group.id,
        telegramChatId: "chat-1",
        commandName: "research",
        skill: "research",
        status: "success",
        estimatedCostCents: 8
      });

      const decision = engineGroupCap.evaluate(makeInput({
        walletId: wallet.id,
        walletStatus: "active",
        groupId: group.id,
        quotedCostCents: 5 // 8 + 5 = 13 > 10 cents
      }));
      expect(decision.outcome).toBe("deny_daily_cap");
      expect(decision.policyType).toBe("group_daily_cap");
    });
  });

  describe("snapshot content", () => {
    it("snapshot includes config and wallet policy at evaluation time", () => {
      const { wallet } = seedWallet(db);
      db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: 5.0, weeklyCapUsdc: 20.0 });

      const decision = engine.evaluate(makeInput({ walletId: wallet.id }));
      const snap = JSON.parse(decision.snapshotJson) as Record<string, unknown>;

      expect(snap.walletId).toBe(wallet.id);
      expect(snap.skill).toBe("research");
      expect((snap.walletPolicy as Record<string, unknown>)?.dailyCapUsdc).toBe(5.0);
      expect((snap.walletPolicy as Record<string, unknown>)?.weeklyCapUsdc).toBe(20.0);
      expect(typeof snap.evaluatedAt).toBe("string");
    });
  });

  describe("DB methods", () => {
    it("upsertWalletPolicy creates and updates", () => {
      const { wallet } = seedWallet(db);
      db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: 5.0 });
      const p1 = db.getWalletPolicy(wallet.id)!;
      expect(p1.daily_cap_usdc).toBe(5.0);
      expect(p1.weekly_cap_usdc).toBeNull();

      db.upsertWalletPolicy(wallet.id, { weeklyCapUsdc: 20.0 });
      const p2 = db.getWalletPolicy(wallet.id)!;
      expect(p2.daily_cap_usdc).toBe(5.0); // preserved
      expect(p2.weekly_cap_usdc).toBe(20.0);
    });

    it("upsertWalletPolicy clears daily cap with null", () => {
      const { wallet } = seedWallet(db);
      db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: 5.0 });
      db.upsertWalletPolicy(wallet.id, { dailyCapUsdc: null });
      expect(db.getWalletPolicy(wallet.id)!.daily_cap_usdc).toBeNull();
    });

    it("upsertSkillPolicy creates and updates status", () => {
      const { wallet } = seedWallet(db);
      db.upsertSkillPolicy(wallet.id, "research", "trusted");
      expect(db.getSkillPolicy(wallet.id, "research")!.status).toBe("trusted");

      db.upsertSkillPolicy(wallet.id, "research", "blocked");
      expect(db.getSkillPolicy(wallet.id, "research")!.status).toBe("blocked");
    });

    it("getWalletSpendCents sums successful transactions", () => {
      const { wallet, user } = seedWallet(db);
      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        telegramChatId: "c",
        commandName: "research",
        status: "success",
        estimatedCostCents: 30
      });
      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        telegramChatId: "c",
        commandName: "research",
        status: "success",
        estimatedCostCents: 20
      });
      const since = new Date(Date.now() - 86400_000).toISOString();
      expect(db.getWalletSpendCents(wallet.id, since)).toBe(50);
    });

    it("hasWalletSucceededTransactions returns false for new wallet", () => {
      const { wallet } = seedWallet(db);
      expect(db.hasWalletSucceededTransactions(wallet.id)).toBe(false);
    });

    it("hasWalletSucceededTransactions returns true after a success", () => {
      const { wallet, user } = seedWallet(db);
      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        telegramChatId: "c",
        commandName: "research",
        status: "success",
        estimatedCostCents: 10
      });
      expect(db.hasWalletSucceededTransactions(wallet.id)).toBe(true);
    });

    it("recordPolicyDecision and getPolicyDecision round-trip", () => {
      const { wallet } = seedWallet(db);
      const quote = db.createQuote({
        userHash: "actor-hash",
        walletId: wallet.id,
        skill: "research",
        endpoint: "https://example.com",
        canonicalRequestJson: "{}",
        requestHash: "req-hash",
        quotedCostCents: 10,
        maxApprovedCostCents: 50,
        isDevUnquoted: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });

      db.recordPolicyDecision(quote.id, wallet.id, "actor-hash", {
        outcome: "allow",
        policyType: "default",
        reason: "No policy restrictions",
        snapshotJson: '{"test":true}'
      });

      const stored = db.getPolicyDecision(quote.id)!;
      expect(stored.outcome).toBe("allow");
      expect(stored.policy_type).toBe("default");
      expect(stored.snapshot_json).toBe('{"test":true}');
    });
  });
});
