import type { AppDatabase } from "../db/client.js";
import type { AppConfig } from "../config.js";

export interface PolicyEvaluationInput {
  platform: "telegram" | "discord";
  actorIdHash: string;
  walletId: string;
  walletStatus: "pending" | "active" | "disabled";
  groupId?: string | null;
  skill: string;
  endpoint: string;
  quotedCostCents: number;
  isDevUnquoted: boolean;
  // undefined = cap disabled (natural language uses forceConfirmation separately)
  confirmationCapUsdc?: number;
  // threshold above which group admin must approve; only relevant when groupId is set
  groupAdminCapUsdc?: number;
}

export type PolicyOutcome =
  | "allow"
  | "require_confirmation"
  | "require_group_admin_approval"
  | "deny_frozen"
  | "deny_daily_cap"
  | "deny_weekly_cap"
  | "deny_skill_blocked"
  | "deny_platform"
  | "deny_hard_cap";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  policyType: string;
  reason: string;
  requiresGroupAdminApproval: boolean;
  capStatusText?: string;
  snapshotJson: string;
}

export class PolicyEngine {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig
  ) {}

  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const walletPolicy = this.db.getWalletPolicy(input.walletId);
    const skillPolicy = this.db.getSkillPolicy(input.walletId, input.skill);
    const snapshotJson = JSON.stringify(this.buildSnapshot(input, walletPolicy, skillPolicy));

    const decide = (
      outcome: PolicyOutcome,
      policyType: string,
      reason: string,
      requiresGroupAdminApproval = false,
      capStatusText?: string
    ): PolicyDecision => ({ outcome, policyType, reason, requiresGroupAdminApproval, capStatusText, snapshotJson });

    // 1. Unknown platform (defensive)
    if (input.platform !== "telegram" && input.platform !== "discord") {
      return decide("deny_platform", "unknown_platform", "Unknown platform denied");
    }

    // 2. Frozen wallet
    if (input.walletStatus === "disabled") {
      return decide("deny_frozen", "frozen_wallet", "Wallet is frozen");
    }

    // 3. Per-wallet skill allowlist
    if (walletPolicy?.skill_allowlist) {
      const allowed = walletPolicy.skill_allowlist.split(",").map(s => s.trim()).filter(Boolean);
      if (!allowed.includes(input.skill)) {
        return decide("deny_skill_blocked", "skill_allowlist", `Skill '${input.skill}' is not in this wallet's allowed skill list`);
      }
    }

    // 4. Per-skill block
    if (skillPolicy?.status === "blocked") {
      return decide("deny_skill_blocked", "skill_blocked", `Skill '${input.skill}' is blocked for this wallet`);
    }

    // 5. Daily wallet cap (per-wallet override, else global POLICY_DAILY_CAP_USDC)
    const dailyCapUsdc = walletPolicy?.daily_cap_usdc ?? this.config.POLICY_DAILY_CAP_USDC;
    if (dailyCapUsdc !== undefined && dailyCapUsdc !== null) {
      const dailyCapCents = Math.round(dailyCapUsdc * 100);
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const spentCents = this.db.getWalletSpendCents(input.walletId, since24h);
      if (spentCents + input.quotedCostCents > dailyCapCents) {
        const capStatusText = `$${(spentCents / 100).toFixed(2)} of $${dailyCapUsdc.toFixed(2)} daily cap used`;
        return decide("deny_daily_cap", "daily_wallet_cap", "Daily spend cap exceeded", false, capStatusText);
      }
    }

    // 6. Weekly wallet cap (per-wallet override, else global POLICY_WEEKLY_CAP_USDC)
    const weeklyCapUsdc = walletPolicy?.weekly_cap_usdc ?? this.config.POLICY_WEEKLY_CAP_USDC;
    if (weeklyCapUsdc !== undefined && weeklyCapUsdc !== null) {
      const weeklyCapCents = Math.round(weeklyCapUsdc * 100);
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const spentCents = this.db.getWalletSpendCents(input.walletId, since7d);
      if (spentCents + input.quotedCostCents > weeklyCapCents) {
        const capStatusText = `$${(spentCents / 100).toFixed(2)} of $${weeklyCapUsdc.toFixed(2)} weekly cap used`;
        return decide("deny_weekly_cap", "weekly_wallet_cap", "Weekly spend cap exceeded", false, capStatusText);
      }
    }

    // 7. Group daily cap (mirrors former assertGroupDailyCap in SkillExecutor)
    if (input.groupId) {
      const groupDailyCapUsdc = this.config.GROUP_DAILY_CAP_USDC ?? 25;
      const groupDailyCapCents = Math.round(groupDailyCapUsdc * 100);
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const groupSpent = this.db.getDailySpendCentsForGroup(input.groupId, since24h);
      if (groupSpent + input.quotedCostCents > groupDailyCapCents) {
        const capStatusText = `$${(groupSpent / 100).toFixed(2)} of $${groupDailyCapUsdc.toFixed(2)} group daily cap used`;
        return decide("deny_daily_cap", "group_daily_cap", "Group daily spend cap exceeded", false, capStatusText);
      }
    }

    // 8. Hard spend cap (absolute deny — no confirmation offered)
    if (!this.config.ALLOW_HIGH_VALUE_CALLS) {
      const hardCapCents = Math.round(this.config.HARD_SPEND_CAP_USDC * 100);
      if (input.quotedCostCents > hardCapCents) {
        return decide(
          "deny_hard_cap",
          "hard_cap",
          `Request exceeds hard safety cap of $${this.config.HARD_SPEND_CAP_USDC.toFixed(2)}`
        );
      }
    }

    // 9. Trusted skill auto-approve (skip remaining checks if cost is low enough)
    const trustedAutoMaxCents = Math.round((this.config.POLICY_TRUSTED_AUTO_APPROVE_MAX_USDC ?? 0.01) * 100);
    const globalTrustedSkills = this.config.POLICY_TRUSTED_SKILLS
      ? this.config.POLICY_TRUSTED_SKILLS.split(",").map(s => s.trim()).filter(Boolean)
      : [];
    const isSkillTrusted = skillPolicy?.status === "trusted" || globalTrustedSkills.includes(input.skill);
    if (isSkillTrusted && input.quotedCostCents <= trustedAutoMaxCents) {
      return decide("allow", "trusted_skill_auto_approve", "Trusted skill auto-approved below threshold");
    }

    // 10. First spend requires confirmation (opt-in, default false)
    if (this.config.POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION) {
      const hasSpent = this.db.hasWalletSucceededTransactions(input.walletId);
      if (!hasSpent) {
        return decide("require_confirmation", "first_spend", "First spend from this wallet requires confirmation");
      }
    }

    // 11. Per-call confirmation cap / group admin approval threshold
    if (input.confirmationCapUsdc !== undefined) {
      const confirmationCapCents = Math.round(input.confirmationCapUsdc * 100);
      if (input.quotedCostCents > confirmationCapCents) {
        if (input.groupId && input.groupAdminCapUsdc !== undefined) {
          const groupAdminCapCents = Math.round(input.groupAdminCapUsdc * 100);
          if (input.quotedCostCents > groupAdminCapCents) {
            return decide("require_group_admin_approval", "group_admin_threshold", "Requires group admin approval (over group cap)", true);
          }
        }
        return decide("require_confirmation", "per_call_cap", `Quoted cost exceeds per-call confirmation cap of $${input.confirmationCapUsdc.toFixed(2)}`);
      }
    }

    // 12. High-cost threshold confirmation (optional operator-defined threshold)
    if (this.config.POLICY_HIGH_COST_THRESHOLD_USDC !== undefined) {
      const highCostCents = Math.round(this.config.POLICY_HIGH_COST_THRESHOLD_USDC * 100);
      if (input.quotedCostCents > highCostCents) {
        return decide(
          "require_confirmation",
          "high_cost",
          `High-cost request ($${(input.quotedCostCents / 100).toFixed(2)}) requires confirmation`
        );
      }
    }

    return decide("allow", "default", "No policy restrictions applied");
  }

  private buildSnapshot(
    input: PolicyEvaluationInput,
    walletPolicy: { daily_cap_usdc: number | null; weekly_cap_usdc: number | null; skill_allowlist: string | null } | undefined,
    skillPolicy: { status: string } | undefined
  ): Record<string, unknown> {
    return {
      evaluatedAt: new Date().toISOString(),
      platform: input.platform,
      walletId: input.walletId,
      walletStatus: input.walletStatus,
      groupId: input.groupId ?? null,
      skill: input.skill,
      quotedCostCents: input.quotedCostCents,
      isDevUnquoted: input.isDevUnquoted,
      confirmationCapUsdc: input.confirmationCapUsdc ?? null,
      groupAdminCapUsdc: input.groupAdminCapUsdc ?? null,
      config: {
        allowHighValueCalls: this.config.ALLOW_HIGH_VALUE_CALLS,
        hardSpendCapUsdc: this.config.HARD_SPEND_CAP_USDC,
        groupDailyCapUsdc: this.config.GROUP_DAILY_CAP_USDC,
        policyDailyCapUsdc: this.config.POLICY_DAILY_CAP_USDC ?? null,
        policyWeeklyCapUsdc: this.config.POLICY_WEEKLY_CAP_USDC ?? null,
        policyHighCostThresholdUsdc: this.config.POLICY_HIGH_COST_THRESHOLD_USDC ?? null,
        policyTrustedSkills: this.config.POLICY_TRUSTED_SKILLS || null,
        policyFirstSpendRequireConfirmation: this.config.POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION
      },
      walletPolicy: walletPolicy
        ? {
            dailyCapUsdc: walletPolicy.daily_cap_usdc,
            weeklyCapUsdc: walletPolicy.weekly_cap_usdc,
            skillAllowlist: walletPolicy.skill_allowlist
          }
        : null,
      skillPolicy: skillPolicy ? { status: skillPolicy.status } : null
    };
  }
}
