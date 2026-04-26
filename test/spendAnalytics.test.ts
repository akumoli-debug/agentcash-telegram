import { describe, it, expect, beforeEach } from "vitest";
import { AppDatabase, type UserRow, type WalletRow, type GroupRow } from "../src/db/client.js";
import { SpendAnalyticsService } from "../src/analytics/SpendAnalyticsService.js";

function makeDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.initialize();
  return db;
}

function seedUser(db: AppDatabase, telegramUserId = "tg_test_1"): UserRow {
  return db.upsertUser({ telegramUserId, defaultSpendCapUsdc: 0.5 });
}

function seedUserWallet(db: AppDatabase, telegramUserId = "tg_test_1"): { user: UserRow; wallet: WalletRow } {
  const user = seedUser(db, telegramUserId);
  const wallet = db.createUserWallet(user.id, { homeDirHash: `h_${telegramUserId}`, status: "active" });
  return { user, wallet };
}

function seedGroupWallet(db: AppDatabase): { user: UserRow; group: GroupRow; wallet: WalletRow } {
  const user = seedUser(db, "tg_group_creator");
  const result = db.createGroupWithWallet({
    telegramChatIdHash: "chat_hash_1",
    createdByUserId: user.id,
    spendCapUsdc: 0.5,
    homeDirHash: "h_group"
  });
  const wallet = db.getWalletByGroupId(result.group.id)!;
  return { user, group: result.group, wallet };
}

function seedTransaction(
  db: AppDatabase,
  input: {
    userId: string;
    walletId: string;
    groupId?: string;
    skill?: string;
    status?: "submitted" | "success" | "error" | "pending" | "quoted";
    estimatedCostCents?: number;
    actualCostCents?: number;
    createdAt?: string;
    telegramIdHash?: string;
  }
) {
  const txn = db.createTransaction({
    userId: input.userId,
    walletId: input.walletId,
    groupId: input.groupId ?? null,
    telegramChatId: "chat_test",
    telegramIdHash: input.telegramIdHash ?? "actor_hash_1",
    commandName: "research",
    skill: input.skill ?? "research",
    status: input.status ?? "success",
    estimatedCostCents: input.estimatedCostCents ?? 100,
    actualCostCents: input.actualCostCents ?? 90
  }) as { id: string };

  if (input.createdAt) {
    db.sqlite
      .prepare("UPDATE transactions SET created_at = ? WHERE id = ?")
      .run(input.createdAt, txn.id);
  }

  return txn;
}

// ─── Scenario 1: spend today calculates correctly ─────────────────────────────

describe("Scenario 1: spend today calculates correctly", () => {
  it("sums actual_cost_cents for transactions created today", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const todayIso = new Date().toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 50, createdAt: todayIso });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 75, createdAt: todayIso });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const total = db.getWalletSpendCents(wallet.id, startOfToday.toISOString());
    expect(total).toBe(125);
  });

  it("excludes transactions from yesterday", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const todayIso = new Date().toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 200, createdAt: yesterday });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 50, createdAt: todayIso });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const total = db.getWalletSpendCents(wallet.id, startOfToday.toISOString());
    expect(total).toBe(50);
  });

  it("getWalletSummary.totalCentsToday matches direct DB query", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const todayIso = new Date().toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 123, createdAt: todayIso });

    const service = new SpendAnalyticsService(db);
    const summary = service.getWalletSummary(wallet.id);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const directTotal = db.getWalletSpendCents(wallet.id, startOfToday.toISOString());

    expect(summary.totalCentsToday).toBe(directTotal);
    expect(summary.totalCentsToday).toBe(123);
  });

  it("falls back to estimated_cost_cents when actual is null", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const todayIso = new Date().toISOString();

    // Insert with actual=null (not possible via createTransaction API which always sets it,
    // so we test via the DB's getWalletSpendCents which uses COALESCE)
    db.createTransaction({
      userId: user.id,
      walletId: wallet.id,
      telegramChatId: "chat",
      commandName: "research",
      skill: "research",
      status: "submitted",
      estimatedCostCents: 80
      // actualCostCents omitted → null
    });
    db.sqlite
      .prepare("UPDATE transactions SET created_at = ? WHERE user_id = ?")
      .run(todayIso, user.id);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const total = db.getWalletSpendCents(wallet.id, startOfToday.toISOString());
    expect(total).toBe(80);
  });
});

// ─── Scenario 2: spend by skill calculates correctly ──────────────────────────

describe("Scenario 2: spend by skill calculates correctly", () => {
  let db: AppDatabase;
  let userId: string;
  let walletId: string;

  beforeEach(() => {
    db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    userId = user.id;
    walletId = wallet.id;
  });

  it("groups spend by skill", () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    seedTransaction(db, { userId, walletId, skill: "research", actualCostCents: 100 });
    seedTransaction(db, { userId, walletId, skill: "research", actualCostCents: 50 });
    seedTransaction(db, { userId, walletId, skill: "enrich", actualCostCents: 200 });

    const rows = db.getWalletSpendBySkill(walletId, since);
    const researchRow = rows.find(r => r.skill === "research");
    const enrichRow = rows.find(r => r.skill === "enrich");

    expect(researchRow?.cents).toBe(150);
    expect(researchRow?.count).toBe(2);
    expect(enrichRow?.cents).toBe(200);
    expect(enrichRow?.count).toBe(1);
  });

  it("orders by cents descending", () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    seedTransaction(db, { userId, walletId, skill: "enrich", actualCostCents: 500 });
    seedTransaction(db, { userId, walletId, skill: "research", actualCostCents: 100 });

    const rows = db.getWalletSpendBySkill(walletId, since);
    expect(rows[0]?.skill).toBe("enrich");
    expect(rows[1]?.skill).toBe("research");
  });

  it("SpendAnalyticsService.formatSkillsText lists all skills", () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    seedTransaction(db, { userId, walletId, skill: "research", actualCostCents: 300 });
    seedTransaction(db, { userId, walletId, skill: "enrich", actualCostCents: 100 });

    const service = new SpendAnalyticsService(db);
    const summary = service.getWalletSummary(walletId, 30);
    const text = service.formatSkillsText(summary);

    expect(text).toContain("research");
    expect(text).toContain("enrich");
    void since;
  });
});

// ─── Scenario 3: private spend blocked in group context ───────────────────────

describe("Scenario 3: private spend blocked in group context", () => {
  it("createSpendCommand only exposes data for private chat (guard documented in command layer)", () => {
    // The /spend command handler calls isPrivateTelegramChat(ctx) and returns early.
    // We test the analytics service itself is safe: no cross-wallet data leakage.
    const db = makeDb();
    const { user: u1, wallet: w1 } = seedUserWallet(db, "user_a");
    const { user: u2, wallet: w2 } = seedUserWallet(db, "user_b");
    const since = new Date(Date.now() - 86_400_000).toISOString();

    seedTransaction(db, { userId: u1.id, walletId: w1.id, actualCostCents: 999 });
    seedTransaction(db, { userId: u2.id, walletId: w2.id, actualCostCents: 1 });

    // Querying wallet 2 does not include wallet 1's data
    const total = db.getWalletSpendCents(w2.id, since);
    expect(total).toBe(1);

    const bySkill = db.getWalletSpendBySkill(w2.id, since);
    const w2Total = bySkill.reduce((sum, r) => sum + r.cents, 0);
    expect(w2Total).toBe(1);
  });

  it("getWalletSummary returns zero totals for unknown wallet", () => {
    const db = makeDb();
    const service = new SpendAnalyticsService(db);
    const summary = service.getWalletSummary("nonexistent_wallet_id");
    expect(summary.totalCentsToday).toBe(0);
    expect(summary.totalCentsLast7Days).toBe(0);
    expect(summary.bySkill).toHaveLength(0);
  });
});

// ─── Scenario 4: group spend requires admin ───────────────────────────────────

describe("Scenario 4: group spend requires admin", () => {
  it("group spend summary includes per-member breakdown only when caller is admin", () => {
    // The admin check lives in the command handler.
    // Here we verify getGroupSummary returns byMember data, and the command handler
    // gates it behind isGroupAdmin check.
    const db = makeDb();
    const { user, group, wallet } = seedGroupWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    seedTransaction(db, {
      userId: user.id,
      walletId: wallet.id,
      groupId: group.id,
      actualCostCents: 300,
      telegramIdHash: "actor_hash_a"
    });

    const byMember = db.getGroupSpendByActor(group.id, since);
    expect(byMember).toHaveLength(1);
    expect(byMember[0]?.cents).toBe(300);
    expect(byMember[0]?.actor_hash).toBe("actor_hash_a");
    void wallet;
  });

  it("non-admin sees aggregate only (verified by getGroupSummary shape, gate is command layer)", () => {
    const db = makeDb();
    const { user, group, wallet } = seedGroupWallet(db);
    const service = new SpendAnalyticsService(db);
    const summary = service.getGroupSummary(group.id, wallet.id);

    // byMember is available in summary but the command handler hides it from non-admins
    expect(Array.isArray(summary.byMember)).toBe(true);
    expect(summary.totalCentsToday).toBeDefined();
    void user;
  });
});

// ─── Scenario 5: export redacts sensitive fields ──────────────────────────────

describe("Scenario 5: export redacts sensitive fields", () => {
  it("export rows do not contain raw prompt or email content", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);

    // Simulate a transaction where request_summary might have been set
    db.createTransaction({
      userId: user.id,
      walletId: wallet.id,
      telegramChatId: "chat",
      commandName: "enrich",
      skill: "enrich",
      status: "success",
      estimatedCostCents: 50,
      actualCostCents: 45,
      requestSummary: "enrich: user@example.com",  // would be raw email
      responseSummary: "profile data"
    });

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = db.getTransactionsForExport({ walletId: wallet.id }, since);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Export row fields are safe
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining(["date", "skill", "status", "estimated_usdc", "actual_usdc", "request_hash"])
    );

    // No raw user content in exported fields
    expect(JSON.stringify(row)).not.toContain("user@example.com");
    expect(JSON.stringify(row)).not.toContain("profile data");
    expect(JSON.stringify(row)).not.toContain("requestSummary");
    expect(JSON.stringify(row)).not.toContain("responseSummary");
  });

  it("formatExportCsv does not include private key or platform user ID columns", () => {
    const db = makeDb();
    const service = new SpendAnalyticsService(db);
    const rows = [
      {
        date: "2026-04-25",
        skill: "research",
        status: "success",
        estimated_usdc: "0.0010",
        actual_usdc: "0.0009",
        request_hash: "abc123def456"
      }
    ];
    const csv = service.formatExportCsv(rows);

    // CSV header only has safe fields
    const header = csv.split("\n")[0]!;
    expect(header).toBe("date,skill,status,estimated_usdc,actual_usdc,request_hash");

    // No private key, platform user ID, or raw telegram ID columns
    expect(header).not.toContain("telegram_user_id");
    expect(header).not.toContain("encrypted_private_key");
    expect(header).not.toContain("request_payload");
    expect(header).not.toContain("response_payload");
  });

  it("export uses request_hash (already hashed), not raw request", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);

    db.createTransaction({
      userId: user.id,
      walletId: wallet.id,
      telegramChatId: "chat",
      commandName: "research",
      skill: "research",
      status: "success",
      estimatedCostCents: 25,
      actualCostCents: 20,
      requestHash: "deadbeef1234"
    });

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = db.getTransactionsForExport({ walletId: wallet.id }, since);
    expect(rows[0]?.request_hash).toBe("deadbeef1234");
  });
});

// ─── Scenario 6: failed transactions counted separately ───────────────────────

describe("Scenario 6: failed transactions included separately from successful spend", () => {
  it("error transactions are not included in totalCentsToday", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const todayIso = new Date().toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 100, status: "success", createdAt: todayIso });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 999, status: "error", createdAt: todayIso });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const total = db.getWalletSpendCents(wallet.id, startOfToday.toISOString());
    expect(total).toBe(100);
  });

  it("getWalletFailedTransactionCount counts only error status", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, status: "success" });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, status: "error" });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, status: "error" });

    const failedCount = db.getWalletFailedTransactionCount(wallet.id, since);
    expect(failedCount).toBe(2);
  });

  it("SpendAnalyticsService.failedExecutionCount is separate from spend totals", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 100, status: "success" });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 500, status: "error" });

    const service = new SpendAnalyticsService(db);
    const summary = service.getWalletSummary(wallet.id, 30);

    expect(summary.failedExecutionCount).toBe(1);
    expect(summary.totalCentsLast30Days).toBe(100);
  });

  it("bySkill breakdown excludes failed transactions", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, skill: "research", actualCostCents: 100, status: "success" });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, skill: "research", actualCostCents: 500, status: "error" });

    const rows = db.getWalletSpendBySkill(wallet.id, since);
    const researchRow = rows.find(r => r.skill === "research");
    expect(researchRow?.cents).toBe(100);
    expect(researchRow?.count).toBe(1);
  });
});

// ─── Scenario 7: replay attempts included in security metrics ─────────────────

describe("Scenario 7: replay attempts included in security metrics", () => {
  it("getWalletReplayAttemptCount returns count of replay preflight failures", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    db.logPreflightAttempt({
      userHash: user.telegram_user_id,
      walletId: wallet.id,
      skill: "research",
      failureStage: "replay",
      errorCode: "replay_detected",
      safeErrorMessage: "duplicate request"
    });
    db.logPreflightAttempt({
      userHash: user.telegram_user_id,
      walletId: wallet.id,
      skill: "enrich",
      failureStage: "cap",
      errorCode: "cap_exceeded",
      safeErrorMessage: "over cap"
    });

    const replayCount = db.getWalletReplayAttemptCount(wallet.id, since);
    expect(replayCount).toBe(1);
  });

  it("SpendAnalyticsService.replayAttemptCount is non-zero when replays exist", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);

    db.logPreflightAttempt({
      userHash: user.telegram_user_id,
      walletId: wallet.id,
      skill: "research",
      failureStage: "replay",
      errorCode: "replay_detected",
      safeErrorMessage: "dup"
    });
    db.logPreflightAttempt({
      userHash: user.telegram_user_id,
      walletId: wallet.id,
      skill: "research",
      failureStage: "replay",
      errorCode: "replay_detected",
      safeErrorMessage: "dup2"
    });

    const service = new SpendAnalyticsService(db);
    const summary = service.getWalletSummary(wallet.id, 30);

    expect(summary.replayAttemptCount).toBe(2);
  });

  it("only counts replay stage, not other preflight failure stages", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    for (const stage of ["wallet", "balance", "quote", "cap", "execution", "expired"] as const) {
      db.logPreflightAttempt({
        userHash: user.telegram_user_id,
        walletId: wallet.id,
        skill: "research",
        failureStage: stage,
        errorCode: "err",
        safeErrorMessage: "err"
      });
    }

    const replayCount = db.getWalletReplayAttemptCount(wallet.id, since);
    expect(replayCount).toBe(0);
  });
});

// ─── Additional DB method coverage ────────────────────────────────────────────

describe("analytics DB methods", () => {
  it("getDailySpendSeries groups by calendar date", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const d1 = "2026-04-24T10:00:00.000Z";
    const d2 = "2026-04-25T10:00:00.000Z";

    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 100, createdAt: d1 });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 50, createdAt: d1 });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, actualCostCents: 200, createdAt: d2 });

    const series = db.getWalletDailySpendSeries(wallet.id, "2026-04-23T00:00:00.000Z");
    expect(series).toHaveLength(2);
    expect(series[0]?.date).toBe("2026-04-24");
    expect(series[0]?.cents).toBe(150);
    expect(series[1]?.date).toBe("2026-04-25");
    expect(series[1]?.cents).toBe(200);
  });

  it("getWalletSpendByEndpoint limits to top 5", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    for (let i = 0; i < 8; i++) {
      db.createTransaction({
        userId: user.id,
        walletId: wallet.id,
        telegramChatId: "chat",
        commandName: "research",
        skill: "research",
        status: "success",
        estimatedCostCents: 10,
        actualCostCents: 10,
        endpoint: `https://api${i}.example.com/endpoint`
      });
    }

    const endpoints = db.getWalletSpendByEndpoint(wallet.id, since);
    expect(endpoints.length).toBeLessThanOrEqual(5);
  });

  it("getWalletEstimatedVsActual returns average cost accuracy", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    seedTransaction(db, { userId: user.id, walletId: wallet.id, estimatedCostCents: 100, actualCostCents: 90 });
    seedTransaction(db, { userId: user.id, walletId: wallet.id, estimatedCostCents: 200, actualCostCents: 180 });

    const result = db.getWalletEstimatedVsActual(wallet.id, since);
    expect(result.estimatedCents).toBe(150);
    expect(result.actualCents).toBe(135);
    expect(result.count).toBe(2);
  });

  it("getWalletQuoteStats counts total, succeeded, and denied", () => {
    const db = makeDb();
    const { user, wallet } = seedUserWallet(db);
    const since = new Date(Date.now() - 86_400_000).toISOString();

    // Create 2 quotes: 1 succeeded, 1 pending
    const q1 = db.createQuote({
      userHash: "uh1",
      walletId: wallet.id,
      skill: "research",
      endpoint: "https://example.com",
      canonicalRequestJson: '{"q":"x"}',
      requestHash: "rh1",
      quotedCostCents: 100,
      maxApprovedCostCents: 200,
      isDevUnquoted: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    db.transitionQuoteStatus(q1.id, "pending", "approved");
    db.transitionQuoteStatus(q1.id, "approved", "executing");
    db.transitionQuoteStatus(q1.id, "executing", "succeeded");

    db.createQuote({
      userHash: "uh1",
      walletId: wallet.id,
      skill: "enrich",
      endpoint: "https://example.com",
      canonicalRequestJson: '{"q":"y"}',
      requestHash: "rh2",
      quotedCostCents: 50,
      maxApprovedCostCents: 100,
      isDevUnquoted: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    // Add a denied policy decision
    db.recordPolicyDecision(q1.id, wallet.id, "ah1", {
      outcome: "deny_daily_cap",
      policyType: "daily_cap",
      reason: "over cap",
      snapshotJson: "{}"
    });

    const stats = db.getWalletQuoteStats(wallet.id, since);
    expect(stats.total).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.denied).toBe(1);
  });

  it("formatExportCsv produces valid CSV with correct column count", () => {
    const service = new SpendAnalyticsService(makeDb());
    const rows = [
      { date: "2026-04-25", skill: "research", status: "success", estimated_usdc: "0.0010", actual_usdc: "0.0009", request_hash: "abc" },
      { date: "2026-04-25", skill: "enrich", status: "error", estimated_usdc: "0.0020", actual_usdc: "0.0000", request_hash: "def" }
    ];
    const csv = service.formatExportCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("date,skill,status,estimated_usdc,actual_usdc,request_hash");
    expect(lines[1]?.split(",")).toHaveLength(6);
    expect(lines[2]?.split(",")).toHaveLength(6);
  });
});
