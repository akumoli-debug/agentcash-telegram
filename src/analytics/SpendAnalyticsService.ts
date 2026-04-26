import type {
  AppDatabase,
  SkillSpendRow,
  ActorSpendRow,
  EndpointSpendRow,
  DailySpendRow
} from "../db/client.js";

export type { SkillSpendRow, ActorSpendRow, EndpointSpendRow, DailySpendRow };

export interface WalletSpendSummary {
  totalCentsToday: number;
  totalCentsLast7Days: number;
  totalCentsLast30Days: number;
  bySkill: SkillSpendRow[];
  byActor: ActorSpendRow[];
  quoteApprovalRate: number | null;
  quoteDenialRate: number | null;
  failedExecutionCount: number;
  replayAttemptCount: number;
  avgEstimatedCents: number;
  avgActualCents: number;
  topEndpoints: EndpointSpendRow[];
  dailySeries: DailySpendRow[];
}

export interface GroupSpendSummary extends WalletSpendSummary {
  byMember: ActorSpendRow[];
}

export interface SpendExportRow {
  date: string;
  skill: string;
  status: string;
  estimated_usdc: string;
  actual_usdc: string;
  request_hash: string;
}

function isoStartOfDay(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export class SpendAnalyticsService {
  constructor(private readonly db: AppDatabase) {}

  getWalletSummary(walletId: string, days = 30): WalletSpendSummary {
    const todaySince = isoStartOfDay(0);
    const sevenDaySince = isoStartOfDay(7);
    const thirtyDaySince = isoStartOfDay(30);
    const since = isoStartOfDay(days);

    const bySkill = this.db.getWalletSpendBySkill(walletId, since);
    const byActor = this.db.getWalletSpendByActor(walletId, since);
    const topEndpoints = this.db.getWalletSpendByEndpoint(walletId, since);
    const dailySeries = this.db.getWalletDailySpendSeries(walletId, since);
    const quoteStats = this.db.getWalletQuoteStats(walletId, since);
    const failedExecutionCount = this.db.getWalletFailedTransactionCount(walletId, since);
    const replayAttemptCount = this.db.getWalletReplayAttemptCount(walletId, since);
    const estVsActual = this.db.getWalletEstimatedVsActual(walletId, since);

    const totalQuotesConsidered = quoteStats.total + quoteStats.denied;

    return {
      totalCentsToday: this.db.getWalletSpendCents(walletId, todaySince),
      totalCentsLast7Days: this.db.getWalletSpendCents(walletId, sevenDaySince),
      totalCentsLast30Days: this.db.getWalletSpendCents(walletId, thirtyDaySince),
      bySkill,
      byActor,
      quoteApprovalRate:
        quoteStats.total > 0 ? quoteStats.succeeded / quoteStats.total : null,
      quoteDenialRate:
        totalQuotesConsidered > 0 ? quoteStats.denied / totalQuotesConsidered : null,
      failedExecutionCount,
      replayAttemptCount,
      avgEstimatedCents: estVsActual.estimatedCents,
      avgActualCents: estVsActual.actualCents,
      topEndpoints,
      dailySeries
    };
  }

  getGroupSummary(groupId: string, walletId: string, days = 30): GroupSpendSummary {
    const todaySince = isoStartOfDay(0);
    const sevenDaySince = isoStartOfDay(7);
    const thirtyDaySince = isoStartOfDay(30);
    const since = isoStartOfDay(days);

    const bySkill = this.db.getGroupSpendBySkill(groupId, since);
    const byActor = this.db.getGroupSpendByActor(groupId, since);
    const topEndpoints = this.db.getGroupSpendByEndpoint(groupId, since);
    const dailySeries = this.db.getGroupDailySpendSeries(groupId, since);
    const quoteStats = this.db.getGroupQuoteStats(groupId, walletId, since);
    const failedExecutionCount = this.db.getGroupFailedTransactionCount(groupId, since);
    const replayAttemptCount = this.db.getWalletReplayAttemptCount(walletId, since);
    const estVsActual = this.db.getGroupEstimatedVsActual(groupId, since);

    const totalQuotesConsidered = quoteStats.total + quoteStats.denied;

    return {
      totalCentsToday: this.db.getDailySpendCentsForGroup(groupId, todaySince),
      totalCentsLast7Days: this.db.getDailySpendCentsForGroup(groupId, sevenDaySince),
      totalCentsLast30Days: this.db.getDailySpendCentsForGroup(groupId, thirtyDaySince),
      bySkill,
      byActor,
      byMember: byActor,
      quoteApprovalRate:
        quoteStats.total > 0 ? quoteStats.succeeded / quoteStats.total : null,
      quoteDenialRate:
        totalQuotesConsidered > 0 ? quoteStats.denied / totalQuotesConsidered : null,
      failedExecutionCount,
      replayAttemptCount,
      avgEstimatedCents: estVsActual.estimatedCents,
      avgActualCents: estVsActual.actualCents,
      topEndpoints,
      dailySeries
    };
  }

  getWalletExportRows(walletId: string, days = 30): SpendExportRow[] {
    const since = isoStartOfDay(days);
    return this.db.getTransactionsForExport({ walletId }, since);
  }

  getGroupExportRows(groupId: string, days = 30): SpendExportRow[] {
    const since = isoStartOfDay(days);
    return this.db.getTransactionsForExport({ groupId }, since);
  }

  formatWalletSummaryText(summary: WalletSpendSummary, title = "Spend overview"): string {
    const lines: string[] = [`${title} (30 days)`];
    lines.push(`Today:          ${centsToUsdDisplay(summary.totalCentsToday)}`);
    lines.push(`Last 7 days:    ${centsToUsdDisplay(summary.totalCentsLast7Days)}`);
    lines.push(`Last 30 days:   ${centsToUsdDisplay(summary.totalCentsLast30Days)}`);

    if (summary.quoteApprovalRate !== null) {
      lines.push(`Approval rate:  ${pct(summary.quoteApprovalRate)}`);
    }
    if (summary.quoteDenialRate !== null && summary.quoteDenialRate > 0) {
      lines.push(`Denied:         ${pct(summary.quoteDenialRate)}`);
    }
    if (summary.failedExecutionCount > 0) {
      lines.push(`Failed calls:   ${summary.failedExecutionCount}`);
    }
    if (summary.replayAttemptCount > 0) {
      lines.push(`Replay blocks:  ${summary.replayAttemptCount}`);
    }
    if (summary.bySkill.length > 0) {
      lines.push("", "By skill:");
      for (const row of summary.bySkill) {
        lines.push(`  ${row.skill.padEnd(10)} ${centsToUsdDisplay(row.cents).padStart(10)}  ${row.count} call${row.count === 1 ? "" : "s"}`);
      }
    }
    return lines.join("\n");
  }

  formatSkillsText(summary: WalletSpendSummary, title = "Spend by skill"): string {
    if (summary.bySkill.length === 0) {
      return `${title} (30 days)\nNo spend recorded.`;
    }
    const lines = [`${title} (30 days)`];
    for (const row of summary.bySkill) {
      lines.push(`  ${row.skill.padEnd(10)} ${centsToUsdDisplay(row.cents).padStart(10)}  ${row.count} call${row.count === 1 ? "" : "s"}`);
    }
    return lines.join("\n");
  }

  formatGroupMemberText(summary: GroupSpendSummary, title = "Spend by member"): string {
    if (summary.byMember.length === 0) {
      return `${title} (30 days)\nNo spend recorded.`;
    }
    const lines = [`${title} (30 days)`];
    for (const row of summary.byMember) {
      const shortHash = row.actor_hash.slice(0, 8);
      lines.push(`  ${shortHash}  ${centsToUsdDisplay(row.cents).padStart(10)}  ${row.count} call${row.count === 1 ? "" : "s"}`);
    }
    return lines.join("\n");
  }

  formatExportCsv(rows: SpendExportRow[]): string {
    const header = "date,skill,status,estimated_usdc,actual_usdc,request_hash";
    if (rows.length === 0) {
      return header + "\n(no data)";
    }
    const body = rows.map(r =>
      [r.date, r.skill, r.status, r.estimated_usdc, r.actual_usdc, r.request_hash].join(",")
    );
    return [header, ...body].join("\n");
  }
}

function centsToUsdDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
