import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { schemaStatements } from "./schema.js";

export interface UserRow {
  id: string;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  cap_enabled: number;
  default_spend_cap_usdc: number;
  created_at: string;
  updated_at: string;
}

export interface WalletRow {
  id: string;
  kind: "user" | "group";
  owner_user_id: string | null;
  owner_group_id: string | null;
  home_dir_hash: string | null;
  address: string | null;
  network: string | null;
  deposit_link: string | null;
  wallet_ref: string | null;
  signer_backend: string;
  public_address: string | null;
  active_key_version: number | null;
  encrypted_private_key: string | null;
  status: "pending" | "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  id: string;
  telegram_chat_id_hash: string;
  platform: "telegram" | "discord";
  guild_id_hash: string | null;
  title_hash: string | null;
  wallet_id: string;
  created_by_user_id: string;
  cap_enabled: number;
  spend_cap_usdc: number;
  created_at: string;
  updated_at: string;
}

export interface GroupMemberRow {
  id: string;
  group_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  updated_at: string;
}

export interface QuoteRow {
  id: string;
  user_hash: string;
  wallet_id: string;
  skill: string;
  endpoint: string;
  canonical_request_json: string;
  request_hash: string;
  quoted_cost_cents: number;
  max_approved_cost_cents: number;
  is_dev_unquoted: number;
  status:
    | "pending"
    | "approved"
    | "executing"
    | "succeeded"
    | "expired"
    | "canceled"
    | "failed"
    | "execution_unknown";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  executed_at: string | null;
  transaction_id: string | null;
  execution_started_at: string | null;
  execution_lease_expires_at: string | null;
  execution_attempt_count: number;
  last_execution_error: string | null;
  upstream_idempotency_key: string | null;
  reconciliation_status: string | null;
  reconciled_at: string | null;
  requester_user_id: string | null;
  group_id: string | null;
  requires_group_admin_approval: number;
  platform: "telegram" | "discord";
  actor_id_hash: string | null;
  wallet_scope: string | null;
}

export interface QuoteInput {
  userHash: string;
  walletId: string;
  skill: string;
  endpoint: string;
  canonicalRequestJson: string;
  requestHash: string;
  quotedCostCents: number;
  maxApprovedCostCents: number;
  isDevUnquoted: boolean;
  expiresAt: string;
  requesterUserId?: string | null;
  groupId?: string | null;
  requiresGroupAdminApproval?: boolean;
  platform?: "telegram" | "discord";
  actorIdHash?: string | null;
  walletScope?: string | null;
}

export interface PreflightAttemptInput {
  userHash: string;
  walletId?: string | null;
  skill: string;
  endpoint?: string | null;
  requestHash?: string | null;
  failureStage: "wallet" | "balance" | "quote" | "cap" | "execution" | "replay" | "expired";
  errorCode: string;
  safeErrorMessage: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  telegram_chat_id: string;
  current_command: string | null;
  state_json: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  minuteCount: number;
  hourCount: number;
}

export interface TransactionInput {
  userId: string;
  walletId?: string | null;
  sessionId?: string | null;
  telegramChatId: string;
  telegramMessageId?: string | null;
  telegramIdHash?: string | null;
  groupId?: string | null;
  commandName: string;
  skill?: string | null;
  origin?: string | null;
  endpoint?: string | null;
  quoteId?: string | null;
  status: "pending" | "quoted" | "submitted" | "success" | "error";
  quotedPriceUsdc?: number | null;
  actualPriceUsdc?: number | null;
  estimatedCostCents?: number | null;
  actualCostCents?: number | null;
  txHash?: string | null;
  requestHash?: string | null;
  responseHash?: string | null;
  requestSummary?: string | null;
  responseSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  idempotencyKey?: string | null;
}

export interface HistoryEntry {
  id: string;
  skill: string | null;
  status: string;
  quoted_price_usdc: number | null;
  actual_cost_cents: number | null;
  request_hash: string | null;
  created_at: string;
  error_code: string | null;
  is_dev_unquoted: number | null;
}

export interface GroupMemberSummary {
  role: GroupMemberRow["role"];
  count: number;
}

export interface TelegramAdminVerificationRow {
  id: string;
  group_id: string;
  user_id: string;
  verified_at: string;
  telegram_status: string;
  expires_at: string;
  source: string;
}

export interface KeyVersionRow {
  id: string;
  wallet_id: string;
  version: number;
  signer_backend: string;
  public_address: string | null;
  status: "active" | "deprecated";
  created_at: string;
  deprecated_at: string | null;
}

export interface WalletKeyRow {
  id: string;
  wallet_id: string;
  key_version_id: string;
  encrypted_private_key: string | null;
  created_at: string;
}

export interface InlinePayloadRow {
  id: string;
  token_hash: string;
  payload_json: string;
  signature: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export type AuditEventName = string;

export interface AuditEventInput {
  eventName: AuditEventName;
  walletId?: string | null;
  quoteId?: string | null;
  transactionId?: string | null;
  actorHash?: string | null;
  groupId?: string | null;
  status?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BeginQuoteExecutionInput {
  leaseExpiresAt: string;
  upstreamIdempotencyKey: string;
}

export interface StuckExecutionRow {
  id: string;
  wallet_id: string;
  skill: string;
  request_hash: string;
  status: QuoteRow["status"];
  execution_started_at: string | null;
  execution_lease_expires_at: string | null;
  execution_attempt_count: number;
  last_execution_error: string | null;
  upstream_idempotency_key: string | null;
  reconciliation_status: string | null;
  transaction_id: string | null;
  created_at: string;
}

export interface PairingCodeRow {
  id: string;
  platform: string;
  actor_id_hash: string;
  code_hash: string;
  status: "pending" | "approved" | "expired" | "revoked";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
}

export interface WalletPolicyRow {
  id: string;
  wallet_id: string;
  daily_cap_usdc: number | null;
  weekly_cap_usdc: number | null;
  skill_allowlist: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillPolicyRow {
  id: string;
  wallet_id: string;
  skill: string;
  status: "allowed" | "trusted" | "blocked";
  created_at: string;
  updated_at: string;
}

export interface PolicyDecisionRow {
  id: string;
  quote_id: string;
  wallet_id: string;
  actor_id_hash: string | null;
  outcome: string;
  policy_type: string;
  reason: string | null;
  snapshot_json: string;
  decided_at: string;
}

export interface SkillSpendRow {
  skill: string;
  cents: number;
  count: number;
}

export interface ActorSpendRow {
  actor_hash: string;
  cents: number;
  count: number;
}

export interface EndpointSpendRow {
  endpoint: string;
  cents: number;
  count: number;
}

export interface DailySpendRow {
  date: string;
  cents: number;
}

export interface QuoteStatsRow {
  total: number;
  succeeded: number;
  denied: number;
}

export interface EstimatedVsActualRow {
  estimatedCents: number;
  actualCents: number;
  count: number;
}

export interface TransactionExportRow {
  date: string;
  skill: string;
  status: string;
  estimated_usdc: string;
  actual_usdc: string;
  request_hash: string;
}

export interface AuditEventRow {
  id: string;
  event_name: string;
  wallet_id: string | null;
  quote_id: string | null;
  transaction_id: string | null;
  actor_hash: string | null;
  group_id: string | null;
  status: string | null;
  metadata_json: string | null;
  shipped_at: string | null;
  ship_attempts: number;
  last_ship_error: string | null;
  sink_name: string | null;
  created_at: string;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isValidQuoteTransition(from: QuoteRow["status"], to: QuoteRow["status"]): boolean {
  const allowed: Record<QuoteRow["status"], QuoteRow["status"][]> = {
    pending: ["approved", "expired", "canceled"],
    approved: ["executing", "expired", "canceled"],
    executing: ["succeeded", "failed", "execution_unknown"],
    succeeded: [],
    failed: [],
    execution_unknown: [],
    expired: [],
    canceled: []
  };

  return allowed[from].includes(to);
}

function canonicalAuditEventName(eventName: string, status?: string | null): string {
  const mapped: Record<string, string> = {
    "wallet.created": "wallet_created",
    "key.rotated": "key_rotated",
    "group_admin.verified": "admin_verified",
    "quote.created": "quote_created",
    "quote.approved": "quote_approved",
    "quote.executing": "quote_execution_started",
    "quote.expired": "quote_expired",
    "paid_call.submitted": "transaction_recorded",
    "paid_call.failed": "quote_execution_failed"
  };

  if (eventName === "quote.rejected") {
    return status === "canceled" ? "quote_canceled" : "quote_execution_failed";
  }

  return mapped[eventName] ?? eventName.replaceAll(".", "_");
}

export class AppDatabase {
  readonly sqlite: Database.Database;

  constructor(databasePath: string) {
    const resolvedPath = databasePath === ":memory:" ? ":memory:" : path.resolve(databasePath);
    if (resolvedPath !== ":memory:") {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }
    this.sqlite = new Database(resolvedPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
  }

  initialize() {
    for (const statement of schemaStatements) {
      this.executeSchemaStatement(statement);
    }

    this.ensureWalletColumn("home_dir_hash", "TEXT");
    this.ensureWalletColumn("network", "TEXT");
    this.ensureWalletColumn("deposit_link", "TEXT");
    this.ensureWalletColumn("wallet_ref", "TEXT");
    this.ensureWalletColumn("signer_backend", "TEXT NOT NULL DEFAULT 'local_cli'");
    this.ensureWalletColumn("public_address", "TEXT");
    this.ensureWalletColumn("active_key_version", "INTEGER");
    this.ensureUserColumn("cap_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureTransactionColumn("telegram_id_hash", "TEXT");
    this.ensureTransactionColumn("skill", "TEXT");
    this.ensureTransactionColumn("estimated_cost_cents", "INTEGER");
    this.ensureTransactionColumn("actual_cost_cents", "INTEGER");
    this.ensureTransactionColumn("request_hash", "TEXT");
    this.ensureTransactionColumn("response_hash", "TEXT");
    this.ensureTransactionColumn("quote_id", "TEXT");
    this.ensureTransactionColumn("group_id", "TEXT");
    this.ensureTransactionColumn("idempotency_key", "TEXT");
    this.ensureQuoteColumn("requester_user_id", "TEXT");
    this.ensureQuoteColumn("group_id", "TEXT");
    this.ensureQuoteColumn("requires_group_admin_approval", "INTEGER NOT NULL DEFAULT 0");
    this.ensureQuoteColumn("platform", "TEXT NOT NULL DEFAULT 'telegram'");
    this.ensureQuoteColumn("actor_id_hash", "TEXT");
    this.ensureQuoteColumn("wallet_scope", "TEXT");
    this.ensureQuoteColumn("execution_started_at", "TEXT");
    this.ensureQuoteColumn("execution_lease_expires_at", "TEXT");
    this.ensureQuoteColumn("execution_attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureQuoteColumn("last_execution_error", "TEXT");
    this.ensureQuoteColumn("upstream_idempotency_key", "TEXT");
    this.ensureQuoteColumn("reconciliation_status", "TEXT");
    this.ensureQuoteColumn("reconciled_at", "TEXT");
    this.ensureGroupColumn("platform", "TEXT NOT NULL DEFAULT 'telegram'");
    this.ensureGroupColumn("guild_id_hash", "TEXT");
    this.ensureGroupColumn("cap_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureGroupColumn("spend_cap_usdc", "REAL NOT NULL DEFAULT 0.5");
    this.ensureAuditEventColumn("shipped_at", "TEXT");
    this.ensureAuditEventColumn("ship_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureAuditEventColumn("last_ship_error", "TEXT");
    this.ensureAuditEventColumn("sink_name", "TEXT");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        telegram_chat_id_hash TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL DEFAULT 'telegram',
        guild_id_hash TEXT,
        title_hash TEXT,
        wallet_id TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        cap_enabled INTEGER NOT NULL DEFAULT 1,
        spend_cap_usdc REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id)
      )
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(group_id, user_id)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS group_members_group_role_idx
      ON group_members(group_id, role)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS telegram_admin_verifications (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        telegram_status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS telegram_admin_verifications_group_user_expires_idx
      ON telegram_admin_verifications(group_id, user_id, expires_at DESC)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS key_versions (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        signer_backend TEXT NOT NULL,
        public_address TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')),
        created_at TEXT NOT NULL,
        deprecated_at TEXT,
        FOREIGN KEY (wallet_id) REFERENCES wallets(id),
        UNIQUE(wallet_id, version)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS key_versions_wallet_status_idx
      ON key_versions(wallet_id, status)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wallet_keys (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        key_version_id TEXT NOT NULL,
        encrypted_private_key TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (wallet_id) REFERENCES wallets(id),
        FOREIGN KEY (key_version_id) REFERENCES key_versions(id)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS wallet_keys_wallet_idx
      ON wallet_keys(wallet_id, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS transactions_group_created_at_idx
      ON transactions(group_id, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_key_unique
      ON transactions(idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        wallet_id TEXT,
        quote_id TEXT,
        transaction_id TEXT,
        actor_hash TEXT,
        group_id TEXT,
        status TEXT,
        metadata_json TEXT,
        shipped_at TEXT,
        ship_attempts INTEGER NOT NULL DEFAULT 0,
        last_ship_error TEXT,
        sink_name TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS audit_events_name_created_at_idx
      ON audit_events(event_name, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS audit_events_quote_idx
      ON audit_events(quote_id, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS audit_events_unshipped_idx
      ON audit_events(shipped_at, created_at ASC)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS inline_payloads (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS inline_payloads_expires_at_idx
      ON inline_payloads(expires_at)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS request_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS request_events_user_created_at_idx
      ON request_events(user_id, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        canonical_request_json TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        quoted_cost_cents INTEGER NOT NULL,
        max_approved_cost_cents INTEGER NOT NULL,
        is_dev_unquoted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        executed_at TEXT,
        transaction_id TEXT,
        execution_started_at TEXT,
        execution_lease_expires_at TEXT,
        execution_attempt_count INTEGER NOT NULL DEFAULT 0,
        last_execution_error TEXT,
        upstream_idempotency_key TEXT,
        reconciliation_status TEXT,
        reconciled_at TEXT,
        requester_user_id TEXT,
        group_id TEXT,
        requires_group_admin_approval INTEGER NOT NULL DEFAULT 0,
        platform TEXT NOT NULL DEFAULT 'telegram',
        actor_id_hash TEXT,
        wallet_scope TEXT
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS quotes_user_hash_created_at_idx
      ON quotes(user_hash, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS quotes_execution_reconciliation_idx
      ON quotes(status, execution_lease_expires_at)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS preflight_attempts (
        id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        wallet_id TEXT,
        skill TEXT NOT NULL,
        endpoint TEXT,
        request_hash TEXT,
        failure_stage TEXT NOT NULL,
        error_code TEXT NOT NULL,
        safe_error_message TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS preflight_attempts_user_hash_idx
      ON preflight_attempts(user_hash, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS delivery_identities (
        user_hash TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS gateway_pairing_codes (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        actor_id_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired', 'revoked')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS gateway_pairing_codes_actor_platform_status_idx
      ON gateway_pairing_codes(platform, actor_id_hash, status, expires_at DESC)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wallet_policies (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL UNIQUE,
        daily_cap_usdc REAL,
        weekly_cap_usdc REAL,
        skill_allowlist TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      )
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS skill_policies (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'trusted', 'blocked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (wallet_id) REFERENCES wallets(id),
        UNIQUE (wallet_id, skill)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS skill_policies_wallet_idx
      ON skill_policies(wallet_id, skill)
    `);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL UNIQUE,
        wallet_id TEXT NOT NULL,
        actor_id_hash TEXT,
        outcome TEXT NOT NULL,
        policy_type TEXT NOT NULL,
        reason TEXT,
        snapshot_json TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        FOREIGN KEY (quote_id) REFERENCES quotes(id)
      )
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS policy_decisions_wallet_decided_at_idx
      ON policy_decisions(wallet_id, decided_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS transactions_wallet_created_at_idx
      ON transactions(wallet_id, created_at DESC)
    `);
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS preflight_attempts_wallet_created_at_idx
      ON preflight_attempts(wallet_id, created_at DESC)
    `);
  }

  close() {
    this.sqlite.close();
  }

  upsertUser(input: {
    telegramUserId: string;
    defaultSpendCapUsdc: number;
  }): UserRow {
    const existing = this.getUserByTelegramId(input.telegramUserId);
    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare(`UPDATE users SET updated_at = ? WHERE telegram_user_id = ?`)
        .run(timestamp, input.telegramUserId);
      return this.getUserByTelegramId(input.telegramUserId)!;
    }

    const id = makeId("usr");
    this.sqlite
      .prepare(
        `
          INSERT INTO users (
            id, telegram_user_id, username, first_name, last_name, cap_enabled, default_spend_cap_usdc, created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
        `
      )
      .run(id, input.telegramUserId, 1, input.defaultSpendCapUsdc, timestamp, timestamp);

    return this.getUserByTelegramId(input.telegramUserId)!;
  }

  upsertDeliveryIdentity(userHash: string, telegramUserId: string): void {
    const timestamp = nowIso();
    this.sqlite
      .prepare(
        `
          INSERT INTO delivery_identities (user_hash, telegram_user_id, created_at, last_seen_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_hash) DO UPDATE SET last_seen_at = ?
        `
      )
      .run(userHash, telegramUserId, timestamp, timestamp, timestamp);
  }

  getUserByTelegramId(telegramUserId: string): UserRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .get(telegramUserId) as UserRow | undefined;
  }

  getUserById(id: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  updateUserCap(
    userId: string,
    input: { amount?: number; enabled?: boolean }
  ): UserRow {
    const current = this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;

    if (!current) {
      throw new Error(`User ${userId} not found`);
    }

    this.sqlite
      .prepare(
        `
          UPDATE users
          SET cap_enabled = ?, default_spend_cap_usdc = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.enabled === undefined ? current.cap_enabled : input.enabled ? 1 : 0,
        input.amount ?? current.default_spend_cap_usdc,
        nowIso(),
        userId
      );

    return this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
  }

  getWalletByUserId(userId: string): WalletRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM wallets WHERE owner_user_id = ? AND kind = 'user' LIMIT 1")
      .get(userId) as WalletRow | undefined;
  }

  getWalletById(id: string): WalletRow | undefined {
    return this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined;
  }

  getWalletByGroupId(groupId: string): WalletRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM wallets WHERE owner_group_id = ? AND kind = 'group' LIMIT 1")
      .get(groupId) as WalletRow | undefined;
  }

  createUserWallet(
    userId: string,
    input: {
      homeDirHash: string;
      address?: string | null;
      network?: string | null;
      depositLink?: string | null;
      walletRef?: string | null;
      signerBackend?: string | null;
      publicAddress?: string | null;
      activeKeyVersion?: number | null;
      encryptedPrivateKey?: string | null;
      status?: WalletRow["status"];
    }
  ): WalletRow {
    const timestamp = nowIso();
    const id = makeId("wal");

    this.sqlite
      .prepare(
        `
          INSERT INTO wallets (
            id, kind, owner_user_id, owner_group_id, home_dir_hash, address, network, deposit_link,
            wallet_ref, signer_backend, public_address, active_key_version, encrypted_private_key,
            status, created_at, updated_at
          ) VALUES (?, 'user', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        userId,
        input.homeDirHash,
        input.address ?? null,
        input.network ?? null,
        input.depositLink ?? null,
        input.walletRef ?? input.homeDirHash,
        input.signerBackend ?? "local_cli",
        input.publicAddress ?? input.address ?? null,
        input.activeKeyVersion ?? null,
        input.encryptedPrivateKey ?? null,
        input.status ?? "pending",
        timestamp,
        timestamp
      );

    this.createAuditEvent({
      eventName: "wallet.created",
      walletId: id,
      status: input.status ?? "pending",
      metadata: { kind: "user" }
    });

    return this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow;
  }

  getGroupByTelegramChatHash(telegramChatIdHash: string): GroupRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM groups WHERE telegram_chat_id_hash = ?")
      .get(telegramChatIdHash) as GroupRow | undefined;
  }

  getGroupByDiscordGuildHash(guildIdHash: string): GroupRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM groups WHERE platform = 'discord' AND guild_id_hash = ?")
      .get(guildIdHash) as GroupRow | undefined;
  }

  getGroupById(groupId: string): GroupRow | undefined {
    return this.sqlite.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as GroupRow | undefined;
  }

  createGroupWithWallet(input: {
    telegramChatIdHash: string;
    titleHash?: string | null;
    createdByUserId: string;
    spendCapUsdc: number;
    homeDirHash: string;
    platform?: GroupRow["platform"];
    guildIdHash?: string | null;
    signerBackend?: string | null;
  }): { group: GroupRow; wallet: WalletRow; member: GroupMemberRow } {
    const create = this.sqlite.transaction(() => {
      const timestamp = nowIso();
      const groupId = makeId("grp");
      const walletId = makeId("wal");
      const memberId = makeId("gmb");

      this.sqlite
        .prepare(
          `
            INSERT INTO groups (
              id, telegram_chat_id_hash, platform, guild_id_hash, title_hash, wallet_id, created_by_user_id,
              cap_enabled, spend_cap_usdc, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `
        )
        .run(
          groupId,
          input.telegramChatIdHash,
          input.platform ?? "telegram",
          input.guildIdHash ?? null,
          input.titleHash ?? null,
          walletId,
          input.createdByUserId,
          input.spendCapUsdc,
          timestamp,
          timestamp
        );

      this.sqlite
        .prepare(
          `
            INSERT INTO wallets (
              id, kind, owner_user_id, owner_group_id, home_dir_hash, address, network,
              deposit_link, wallet_ref, signer_backend, public_address, active_key_version,
              encrypted_private_key, status, created_at, updated_at
            ) VALUES (?, 'group', NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, 'pending', ?, ?)
          `
        )
        .run(
          walletId,
          groupId,
          input.homeDirHash,
          input.homeDirHash,
          input.signerBackend ?? "local_cli",
          timestamp,
          timestamp
        );

      this.sqlite
        .prepare(
          `
            INSERT INTO group_members (id, group_id, user_id, role, created_at, updated_at)
            VALUES (?, ?, ?, 'owner', ?, ?)
          `
        )
        .run(memberId, groupId, input.createdByUserId, timestamp, timestamp);

      this.createAuditEvent({
        eventName: "wallet.created",
        walletId,
        groupId,
        status: "pending",
        metadata: { kind: "group" }
      });
      this.createAuditEvent({
        eventName: input.platform === "discord" ? "discord_guild_wallet_created" : "group_wallet_created",
        walletId,
        groupId,
        actorHash: input.createdByUserId,
        status: "pending"
      });

      return {
        group: this.getGroupById(groupId)!,
        wallet: this.getWalletById(walletId)!,
        member: this.getGroupMember(groupId, input.createdByUserId)!
      };
    });

    return create();
  }

  ensureGroupMember(
    groupId: string,
    userId: string,
    role: GroupMemberRow["role"] = "member"
  ): GroupMemberRow {
    const existing = this.getGroupMember(groupId, userId);
    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare("UPDATE group_members SET updated_at = ? WHERE id = ?")
        .run(timestamp, existing.id);
      return this.getGroupMember(groupId, userId)!;
    }

    const id = makeId("gmb");
    this.sqlite
      .prepare(
        `
          INSERT INTO group_members (id, group_id, user_id, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(id, groupId, userId, role, timestamp, timestamp);

    return this.getGroupMember(groupId, userId)!;
  }

  getGroupMember(groupId: string, userId: string): GroupMemberRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM group_members WHERE group_id = ? AND user_id = ?")
      .get(groupId, userId) as GroupMemberRow | undefined;
  }

  getGroupMembers(groupId: string): GroupMemberRow[] {
    return this.sqlite
      .prepare("SELECT * FROM group_members WHERE group_id = ?")
      .all(groupId) as GroupMemberRow[];
  }

  updateGroupMemberRole(
    groupId: string,
    userId: string,
    role: GroupMemberRow["role"]
  ): { member: GroupMemberRow; changed: boolean; previousRole?: GroupMemberRow["role"] } {
    const existing = this.getGroupMember(groupId, userId);
    const timestamp = nowIso();

    if (!existing) {
      const member = this.ensureGroupMember(groupId, userId, role);
      return { member, changed: true };
    }

    if (existing.role === role) {
      return { member: existing, changed: false, previousRole: existing.role };
    }

    this.sqlite
      .prepare("UPDATE group_members SET role = ?, updated_at = ? WHERE id = ?")
      .run(role, timestamp, existing.id);

    return {
      member: this.getGroupMember(groupId, userId)!,
      changed: true,
      previousRole: existing.role
    };
  }

  getGroupMemberSummaries(groupId: string): GroupMemberSummary[] {
    return this.sqlite
      .prepare(
        `
          SELECT role, COUNT(*) AS count
          FROM group_members
          WHERE group_id = ?
          GROUP BY role
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
        `
      )
      .all(groupId) as GroupMemberSummary[];
  }

  updateGroupCap(
    groupId: string,
    input: { amount?: number; enabled?: boolean }
  ): GroupRow {
    const current = this.getGroupById(groupId);

    if (!current) {
      throw new Error(`Group ${groupId} not found`);
    }

    this.sqlite
      .prepare(
        `
          UPDATE groups
          SET cap_enabled = ?, spend_cap_usdc = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.enabled === undefined ? current.cap_enabled : input.enabled ? 1 : 0,
        input.amount ?? current.spend_cap_usdc,
        nowIso(),
        groupId
      );

    return this.getGroupById(groupId)!;
  }

  recordTelegramAdminVerification(input: {
    groupId: string;
    userId: string;
    telegramStatus: string;
    source: string;
    verifiedAt?: string;
    expiresAt?: string;
  }): TelegramAdminVerificationRow {
    const verifiedAt = input.verifiedAt ?? nowIso();
    const expiresAt =
      input.expiresAt ?? new Date(new Date(verifiedAt).getTime() + 5 * 60_000).toISOString();
    const id = makeId("tav");

    this.sqlite
      .prepare(
        `
          INSERT INTO telegram_admin_verifications (
            id, group_id, user_id, verified_at, telegram_status, expires_at, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(id, input.groupId, input.userId, verifiedAt, input.telegramStatus, expiresAt, input.source);

    this.createAuditEvent({
      eventName: "group_admin.verified",
      groupId: input.groupId,
      actorHash: input.userId,
      status: input.telegramStatus,
      metadata: { source: input.source }
    });

    return this.sqlite
      .prepare("SELECT * FROM telegram_admin_verifications WHERE id = ?")
      .get(id) as TelegramAdminVerificationRow;
  }

  hasFreshTelegramAdminVerification(groupId: string, userId: string, now = nowIso()): boolean {
    const row = this.sqlite
      .prepare(
        `
          SELECT * FROM telegram_admin_verifications
          WHERE group_id = ?
            AND user_id = ?
            AND telegram_status IN ('creator', 'administrator')
            AND expires_at > ?
          ORDER BY expires_at DESC
          LIMIT 1
        `
      )
      .get(groupId, userId, now) as TelegramAdminVerificationRow | undefined;

    return Boolean(row);
  }

  updateWallet(
    id: string,
    input: {
      homeDirHash?: string | null;
      address?: string | null;
      network?: string | null;
      depositLink?: string | null;
      walletRef?: string | null;
      signerBackend?: string | null;
      publicAddress?: string | null;
      activeKeyVersion?: number | null;
      encryptedPrivateKey?: string | null;
      status?: WalletRow["status"];
    }
  ): WalletRow {
    const current = this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined;

    if (!current) {
      throw new Error(`Wallet ${id} not found`);
    }

    this.sqlite
      .prepare(
        `
          UPDATE wallets
          SET home_dir_hash = ?, address = ?, network = ?, deposit_link = ?,
              wallet_ref = ?, signer_backend = ?, public_address = ?, active_key_version = ?,
              encrypted_private_key = ?, status = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.homeDirHash ?? current.home_dir_hash,
        input.address ?? current.address,
        input.network ?? current.network,
        input.depositLink ?? current.deposit_link,
        input.walletRef ?? current.wallet_ref,
        input.signerBackend ?? current.signer_backend,
        input.publicAddress ?? current.public_address,
        input.activeKeyVersion ?? current.active_key_version,
        input.encryptedPrivateKey ?? current.encrypted_private_key,
        input.status ?? current.status,
        nowIso(),
        id
      );

    return this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow;
  }

  recordWalletKeyIfMissing(input: {
    walletId: string;
    encryptedPrivateKey?: string | null;
    signerBackend: string;
    publicAddress?: string | null;
  }): KeyVersionRow | undefined {
    const existing = this.sqlite
      .prepare("SELECT * FROM key_versions WHERE wallet_id = ? ORDER BY version DESC LIMIT 1")
      .get(input.walletId) as KeyVersionRow | undefined;

    if (existing || !input.encryptedPrivateKey) {
      return existing;
    }

    const timestamp = nowIso();
    const keyVersionId = makeId("keyv");
    const walletKeyId = makeId("wkey");

    this.sqlite
      .prepare(
        `
          INSERT INTO key_versions (
            id, wallet_id, version, signer_backend, public_address, status, created_at, deprecated_at
          ) VALUES (?, ?, 1, ?, ?, 'active', ?, NULL)
        `
      )
      .run(keyVersionId, input.walletId, input.signerBackend, input.publicAddress ?? null, timestamp);

    this.sqlite
      .prepare(
        `
          INSERT INTO wallet_keys (id, wallet_id, key_version_id, encrypted_private_key, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(walletKeyId, input.walletId, keyVersionId, input.encryptedPrivateKey, timestamp);

    this.sqlite
      .prepare("UPDATE wallets SET active_key_version = 1, updated_at = ? WHERE id = ?")
      .run(timestamp, input.walletId);

    return this.sqlite.prepare("SELECT * FROM key_versions WHERE id = ?").get(keyVersionId) as KeyVersionRow;
  }

  rotateLocalDemoWalletKey(input: {
    walletId: string;
    encryptedPrivateKey: string;
    publicAddress?: string | null;
    signerBackend?: string;
    actorHash?: string | null;
  }): KeyVersionRow {
    const rotate = this.sqlite.transaction(() => {
      const current = this.getWalletById(input.walletId);
      if (!current) {
        throw new Error(`Wallet ${input.walletId} not found`);
      }

      const timestamp = nowIso();
      let maxVersion = (
        this.sqlite
          .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM key_versions WHERE wallet_id = ?")
          .get(input.walletId) as { version: number }
      ).version;

      if (maxVersion === 0 && current.encrypted_private_key) {
        maxVersion = 1;
        const deprecatedId = makeId("keyv");
        this.sqlite
          .prepare(
            `
              INSERT INTO key_versions (
                id, wallet_id, version, signer_backend, public_address, status, created_at, deprecated_at
              ) VALUES (?, ?, 1, ?, ?, 'deprecated', ?, ?)
            `
          )
          .run(
            deprecatedId,
            input.walletId,
            current.signer_backend,
            current.public_address ?? current.address,
            current.created_at,
            timestamp
          );
        this.sqlite
          .prepare(
            `
              INSERT INTO wallet_keys (id, wallet_id, key_version_id, encrypted_private_key, created_at)
              VALUES (?, ?, ?, ?, ?)
            `
          )
          .run(makeId("wkey"), input.walletId, deprecatedId, current.encrypted_private_key, timestamp);
      } else {
        this.sqlite
          .prepare(
            `
              UPDATE key_versions
              SET status = 'deprecated', deprecated_at = COALESCE(deprecated_at, ?)
              WHERE wallet_id = ? AND status = 'active'
            `
          )
          .run(timestamp, input.walletId);
      }

      const nextVersion = maxVersion + 1;
      const keyVersionId = makeId("keyv");
      const signerBackend = input.signerBackend ?? current.signer_backend;

      this.sqlite
        .prepare(
          `
            INSERT INTO key_versions (
              id, wallet_id, version, signer_backend, public_address, status, created_at, deprecated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)
          `
        )
        .run(
          keyVersionId,
          input.walletId,
          nextVersion,
          signerBackend,
          input.publicAddress ?? current.public_address ?? current.address,
          timestamp
        );

      this.sqlite
        .prepare(
          `
            INSERT INTO wallet_keys (id, wallet_id, key_version_id, encrypted_private_key, created_at)
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(makeId("wkey"), input.walletId, keyVersionId, input.encryptedPrivateKey, timestamp);

      this.sqlite
        .prepare(
          `
            UPDATE wallets
            SET encrypted_private_key = ?, public_address = ?, address = COALESCE(?, address),
                signer_backend = ?, active_key_version = ?, updated_at = ?
            WHERE id = ?
          `
        )
        .run(
          input.encryptedPrivateKey,
          input.publicAddress ?? current.public_address,
          input.publicAddress ?? null,
          signerBackend,
          nextVersion,
          timestamp,
          input.walletId
        );

      this.createAuditEvent({
        eventName: "key.rotated",
        walletId: input.walletId,
        actorHash: input.actorHash ?? null,
        status: "active",
        metadata: {
          previousKeyVersion: maxVersion || null,
          activeKeyVersion: nextVersion,
          signerBackend,
          migrationRequired: true
        }
      });

      return this.sqlite.prepare("SELECT * FROM key_versions WHERE id = ?").get(keyVersionId) as KeyVersionRow;
    });

    return rotate();
  }

  createQuote(input: QuoteInput): QuoteRow {
    const id = makeId("quo");
    const timestamp = nowIso();

    this.sqlite
      .prepare(
        `
          INSERT INTO quotes (
            id, user_hash, wallet_id, skill, endpoint, canonical_request_json, request_hash,
            quoted_cost_cents, max_approved_cost_cents, is_dev_unquoted, status,
            created_at, expires_at, approved_at, executed_at, transaction_id,
            requester_user_id, group_id, requires_group_admin_approval, platform, actor_id_hash, wallet_scope
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.userHash,
        input.walletId,
        input.skill,
        input.endpoint,
        input.canonicalRequestJson,
        input.requestHash,
        input.quotedCostCents,
        input.maxApprovedCostCents,
        input.isDevUnquoted ? 1 : 0,
        timestamp,
        input.expiresAt,
        input.requesterUserId ?? null,
        input.groupId ?? null,
        input.requiresGroupAdminApproval ? 1 : 0,
        input.platform ?? "telegram",
        input.actorIdHash ?? null,
        input.walletScope ?? null
      );

    this.createAuditEvent({
      eventName: "quote.created",
      walletId: input.walletId,
      quoteId: id,
      actorHash: input.userHash,
      groupId: input.groupId ?? null,
      status: "pending",
      metadata: {
        skill: input.skill,
        quotedCostCents: input.quotedCostCents,
        isDevUnquoted: input.isDevUnquoted
      }
    });

    return this.sqlite.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as QuoteRow;
  }

  getQuote(id: string): QuoteRow | undefined {
    return this.sqlite.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as QuoteRow | undefined;
  }

  /**
   * Atomically transitions a quote from 'pending' to 'approved'.
   * Returns true only if the transition succeeded (prevents replay attacks).
   */
  atomicApproveQuote(id: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = 'approved', approved_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `
      )
      .run(nowIso(), id, nowIso()) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName: "quote.approved",
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status: "approved"
      });
    }

    return result.changes > 0;
  }

  atomicBeginQuoteExecution(id: string, input?: BeginQuoteExecutionInput): boolean {
    const timestamp = nowIso();
    const leaseExpiresAt = input?.leaseExpiresAt ?? new Date(Date.now() + 120_000).toISOString();
    const upstreamIdempotencyKey = input?.upstreamIdempotencyKey ?? null;
    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = 'executing',
              approved_at = COALESCE(approved_at, ?),
              execution_started_at = ?,
              execution_lease_expires_at = ?,
              execution_attempt_count = execution_attempt_count + 1,
              last_execution_error = NULL,
              upstream_idempotency_key = COALESCE(upstream_idempotency_key, ?),
              reconciliation_status = NULL,
              reconciled_at = NULL
          WHERE id = ? AND status IN ('pending', 'approved') AND expires_at > ?
        `
      )
      .run(timestamp, timestamp, leaseExpiresAt, upstreamIdempotencyKey, id, timestamp) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName: "quote.executing",
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status: "executing"
      });
    }

    return result.changes > 0;
  }

  getLatestTransactionForQuote(quoteId: string): Record<string, unknown> | undefined {
    return this.sqlite
      .prepare(
        `
          SELECT *
          FROM transactions
          WHERE quote_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(quoteId) as Record<string, unknown> | undefined;
  }

  listExpiredExecutingQuotes(now = nowIso(), limit = 50): QuoteRow[] {
    return this.sqlite
      .prepare(
        `
          SELECT *
          FROM quotes
          WHERE status = 'executing'
            AND execution_lease_expires_at IS NOT NULL
            AND execution_lease_expires_at <= ?
          ORDER BY execution_lease_expires_at ASC
          LIMIT ?
        `
      )
      .all(now, limit) as QuoteRow[];
  }

  listStuckExecutions(limit = 50): StuckExecutionRow[] {
    return this.sqlite
      .prepare(
        `
          SELECT
            id,
            wallet_id,
            skill,
            request_hash,
            status,
            execution_started_at,
            execution_lease_expires_at,
            execution_attempt_count,
            last_execution_error,
            upstream_idempotency_key,
            reconciliation_status,
            transaction_id,
            created_at
          FROM quotes
          WHERE status IN ('executing', 'execution_unknown')
          ORDER BY COALESCE(execution_lease_expires_at, created_at) ASC
          LIMIT ?
        `
      )
      .all(limit) as StuckExecutionRow[];
  }

  markQuoteExecutionUnknown(id: string, safeError: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = 'execution_unknown',
              execution_lease_expires_at = NULL,
              last_execution_error = ?,
              reconciliation_status = 'operator_review_required',
              reconciled_at = NULL
          WHERE id = ? AND status = 'executing'
        `
      )
      .run(safeError.slice(0, 512), id) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName: "quote.execution_unknown",
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status: "execution_unknown",
        metadata: { reconciliationStatus: "operator_review_required" }
      });
    }

    return result.changes > 0;
  }

  markExecutionReviewed(id: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET reconciliation_status = 'reviewed',
              reconciled_at = ?
          WHERE id = ? AND status = 'execution_unknown'
        `
      )
      .run(nowIso(), id) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName: "quote.execution_reviewed",
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status: "reviewed"
      });
    }

    return result.changes > 0;
  }

  updateQuoteStatus(
    id: string,
    status: QuoteRow["status"],
    extras?: { executedAt?: string; transactionId?: string; lastExecutionError?: string }
  ): void {
    this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = ?,
              executed_at = COALESCE(?, executed_at),
              transaction_id = COALESCE(?, transaction_id),
              execution_lease_expires_at = CASE WHEN ? IN ('succeeded', 'failed', 'execution_unknown') THEN NULL ELSE execution_lease_expires_at END,
              last_execution_error = COALESCE(?, last_execution_error),
              reconciliation_status = CASE
                WHEN ? = 'execution_unknown' THEN 'operator_review_required'
                WHEN ? IN ('succeeded', 'failed') THEN 'not_required'
                ELSE reconciliation_status
              END
          WHERE id = ?
        `
      )
      .run(
        status,
        extras?.executedAt ?? null,
        extras?.transactionId ?? null,
        status,
        extras?.lastExecutionError ? extras.lastExecutionError.slice(0, 512) : null,
        status,
        status,
        id
      );

    if (status === "expired" || status === "canceled" || status === "failed" || status === "execution_unknown") {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName:
          status === "expired"
            ? "quote.expired"
            : status === "execution_unknown"
            ? "quote.execution_unknown"
            : "quote.rejected",
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        transactionId: extras?.transactionId ?? quote?.transaction_id ?? null,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status
      });
    }
  }

  transitionQuoteStatus(
    id: string,
    from: QuoteRow["status"],
    to: QuoteRow["status"],
    extras?: { executedAt?: string; transactionId?: string; lastExecutionError?: string }
  ): boolean {
    if (!isValidQuoteTransition(from, to)) {
      return false;
    }

    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = ?,
              executed_at = COALESCE(?, executed_at),
              transaction_id = COALESCE(?, transaction_id),
              execution_lease_expires_at = CASE WHEN ? IN ('succeeded', 'failed', 'execution_unknown') THEN NULL ELSE execution_lease_expires_at END,
              last_execution_error = COALESCE(?, last_execution_error),
              reconciliation_status = CASE
                WHEN ? = 'execution_unknown' THEN 'operator_review_required'
                WHEN ? IN ('succeeded', 'failed') THEN 'not_required'
                ELSE reconciliation_status
              END
          WHERE id = ? AND status = ?
        `
      )
      .run(
        to,
        extras?.executedAt ?? null,
        extras?.transactionId ?? null,
        to,
        extras?.lastExecutionError ? extras.lastExecutionError.slice(0, 512) : null,
        to,
        to,
        id,
        from
      ) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      const eventName =
        to === "succeeded"
          ? "quote_execution_succeeded"
          : to === "failed"
          ? "quote_execution_failed"
          : to === "execution_unknown"
          ? "quote_execution_unknown"
          : to === "canceled"
          ? "quote_canceled"
          : to === "expired"
          ? "quote_expired"
          : `quote_${to}`;
      this.createAuditEvent({
        eventName,
        walletId: quote?.wallet_id ?? null,
        quoteId: id,
        transactionId: extras?.transactionId ?? quote?.transaction_id ?? null,
        actorHash: quote?.user_hash ?? null,
        groupId: quote?.group_id ?? null,
        status: to
      });
    }

    return result.changes > 0;
  }

  logPreflightAttempt(input: PreflightAttemptInput): void {
    this.sqlite
      .prepare(
        `
          INSERT INTO preflight_attempts (
            id, user_hash, wallet_id, skill, endpoint, request_hash,
            failure_stage, error_code, safe_error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        makeId("pfa"),
        input.userHash,
        input.walletId ?? null,
        input.skill,
        input.endpoint ?? null,
        input.requestHash ?? null,
        input.failureStage,
        input.errorCode,
        input.safeErrorMessage,
        nowIso()
      );

    if (input.failureStage === "replay") {
      this.createAuditEvent({
        eventName: "suspicious_replay_attempt",
        walletId: input.walletId ?? null,
        actorHash: input.userHash,
        status: input.errorCode,
        metadata: {
          skill: input.skill,
          errorCode: input.errorCode
        }
      });
    }
  }

  upsertSession(input: {
    userId: string;
    telegramChatId: string;
    currentCommand?: string | null;
    stateJson?: string | null;
  }): SessionRow {
    const existing = this.sqlite
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND telegram_chat_id = ?")
      .get(input.userId, input.telegramChatId) as SessionRow | undefined;

    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare(
          `
            UPDATE sessions
            SET current_command = ?, state_json = ?, last_seen_at = ?, updated_at = ?
            WHERE id = ?
          `
        )
        .run(
          input.currentCommand === undefined ? existing.current_command : input.currentCommand,
          input.stateJson === undefined ? existing.state_json : input.stateJson,
          timestamp,
          timestamp,
          existing.id
        );

      return this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(existing.id) as SessionRow;
    }

    const id = makeId("ses");
    this.sqlite
      .prepare(
        `
          INSERT INTO sessions (
            id, user_id, telegram_chat_id, current_command, state_json, last_seen_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.userId,
        input.telegramChatId,
        input.currentCommand ?? null,
        input.stateJson ?? null,
        timestamp,
        timestamp,
        timestamp
      );

    return this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
  }

  getSession(userId: string, telegramChatId: string): SessionRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND telegram_chat_id = ?")
      .get(userId, telegramChatId) as SessionRow | undefined;
  }

  clearSessionState(userId: string, telegramChatId: string): void {
    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET current_command = NULL, state_json = NULL, last_seen_at = ?, updated_at = ?
          WHERE user_id = ? AND telegram_chat_id = ?
        `
      )
      .run(nowIso(), nowIso(), userId, telegramChatId);
  }

  consumeSessionState(
    userId: string,
    telegramChatId: string,
    expectedStateJson: string
  ): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET current_command = NULL, state_json = NULL, last_seen_at = ?, updated_at = ?
          WHERE user_id = ? AND telegram_chat_id = ? AND state_json = ?
        `
      )
      .run(nowIso(), nowIso(), userId, telegramChatId, expectedStateJson) as {
      changes: number;
    };

    return result.changes > 0;
  }

  checkAndRecordRateLimit(
    userId: string,
    input: {
      eventName: string;
      maxPerMinute: number;
      maxPerHour: number;
    }
  ): RateLimitCheckResult {
    const execute = this.sqlite.transaction(() => {
      const now = new Date();
      const nowValue = now.toISOString();
      const minuteSince = new Date(now.getTime() - 60_000).toISOString();
      const hourSince = new Date(now.getTime() - 3_600_000).toISOString();
      const pruneBefore = new Date(now.getTime() - 7_200_000).toISOString();

      this.sqlite
        .prepare("DELETE FROM request_events WHERE created_at < ?")
        .run(pruneBefore);

      const minuteCount = (
        this.sqlite
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM request_events
              WHERE user_id = ? AND created_at >= ?
            `
          )
          .get(userId, minuteSince) as { count: number }
      ).count;

      const hourCount = (
        this.sqlite
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM request_events
              WHERE user_id = ? AND created_at >= ?
            `
          )
          .get(userId, hourSince) as { count: number }
      ).count;

      if (minuteCount >= input.maxPerMinute || hourCount >= input.maxPerHour) {
        return {
          allowed: false,
          minuteCount,
          hourCount
        };
      }

      this.sqlite
        .prepare(
          `
            INSERT INTO request_events (id, user_id, event_name, created_at)
            VALUES (?, ?, ?, ?)
          `
        )
        .run(makeId("req"), userId, input.eventName, nowValue);

      return {
        allowed: true,
        minuteCount: minuteCount + 1,
        hourCount: hourCount + 1
      };
    });

    return execute();
  }

  createTransaction(input: TransactionInput) {
    const id = makeId("txn");
    const timestamp = nowIso();

    this.sqlite
      .prepare(
        `
          INSERT INTO transactions (
            id, user_id, wallet_id, session_id, telegram_chat_id, telegram_message_id, telegram_id_hash, group_id, command_name,
            skill, origin, endpoint, quote_id, status, quoted_price_usdc, actual_price_usdc, estimated_cost_cents, actual_cost_cents, tx_hash,
            idempotency_key, request_hash, response_hash, request_summary, response_summary, error_code, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.userId,
        input.walletId ?? null,
        input.sessionId ?? null,
        input.telegramChatId,
        input.telegramMessageId ?? null,
        input.telegramIdHash ?? null,
        input.groupId ?? null,
        input.commandName,
        input.skill ?? null,
        input.origin ?? null,
        input.endpoint ?? null,
        input.quoteId ?? null,
        input.status,
        input.quotedPriceUsdc ?? null,
        input.actualPriceUsdc ?? null,
        input.estimatedCostCents ?? null,
        input.actualCostCents ?? null,
        input.txHash ?? null,
        input.idempotencyKey ?? null,
        input.requestHash ?? null,
        input.responseHash ?? null,
        input.requestSummary ?? null,
        input.responseSummary ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        timestamp,
        timestamp
      );

    if (input.status === "submitted" || input.status === "success") {
      this.createAuditEvent({
        eventName: "paid_call.submitted",
        walletId: input.walletId ?? null,
        quoteId: input.quoteId ?? null,
        transactionId: id,
        actorHash: input.telegramIdHash ?? null,
        groupId: input.groupId ?? null,
        status: input.status,
        metadata: {
          commandName: input.commandName,
          skill: input.skill ?? null,
          estimatedCostCents: input.estimatedCostCents ?? null
        }
      });
    }

    return this.sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  }

  updateTransaction(
    id: string,
    input: Partial<TransactionInput>
  ) {
    const current = this.sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

    if (!current) {
      throw new Error(`Transaction ${id} not found`);
    }

    this.sqlite
      .prepare(
        `
          UPDATE transactions
          SET wallet_id = ?, session_id = ?, telegram_chat_id = ?, telegram_message_id = ?, telegram_id_hash = ?, group_id = ?,
              command_name = ?, skill = ?, origin = ?, endpoint = ?, quote_id = ?, status = ?, quoted_price_usdc = ?,
              actual_price_usdc = ?, estimated_cost_cents = ?, actual_cost_cents = ?, tx_hash = ?,
              request_hash = ?, response_hash = ?, request_summary = ?, response_summary = ?, error_code = ?,
              error_message = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.walletId ?? current.wallet_id ?? null,
        input.sessionId ?? current.session_id ?? null,
        input.telegramChatId ?? current.telegram_chat_id ?? null,
        input.telegramMessageId ?? current.telegram_message_id ?? null,
        input.telegramIdHash ?? current.telegram_id_hash ?? null,
        input.groupId ?? current.group_id ?? null,
        input.commandName ?? current.command_name ?? null,
        input.skill ?? current.skill ?? null,
        input.origin ?? current.origin ?? null,
        input.endpoint ?? current.endpoint ?? null,
        input.quoteId ?? current.quote_id ?? null,
        input.status ?? current.status ?? null,
        input.quotedPriceUsdc ?? current.quoted_price_usdc ?? null,
        input.actualPriceUsdc ?? current.actual_price_usdc ?? null,
        input.estimatedCostCents ?? current.estimated_cost_cents ?? null,
        input.actualCostCents ?? current.actual_cost_cents ?? null,
        input.txHash ?? current.tx_hash ?? null,
        input.requestHash ?? current.request_hash ?? null,
        input.responseHash ?? current.response_hash ?? null,
        input.requestSummary ?? current.request_summary ?? null,
        input.responseSummary ?? current.response_summary ?? null,
        input.errorCode ?? current.error_code ?? null,
        input.errorMessage ?? current.error_message ?? null,
        nowIso(),
        id
      );

    if (input.status === "error") {
      this.createAuditEvent({
        eventName: "paid_call.failed",
        walletId: String(input.walletId ?? current.wallet_id ?? ""),
        quoteId: String(input.quoteId ?? current.quote_id ?? ""),
        transactionId: id,
        actorHash: String(input.telegramIdHash ?? current.telegram_id_hash ?? ""),
        groupId: input.groupId === undefined ? (current.group_id as string | null) : input.groupId ?? null,
        status: "error",
        metadata: {
          errorCode: input.errorCode ?? null
        }
      });
    }

    return this.sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  }

  getHistoryForUser(telegramIdHash: string, limit = 10): HistoryEntry[] {
    return this.sqlite
      .prepare(
        `
          SELECT
            t.id,
            t.skill,
            t.status,
            t.quoted_price_usdc,
            t.actual_cost_cents,
            t.request_hash,
            t.created_at,
            t.error_code,
            q.is_dev_unquoted
          FROM transactions t
          LEFT JOIN quotes q ON t.quote_id = q.id
          WHERE t.telegram_id_hash = ?
          ORDER BY t.created_at DESC
          LIMIT ?
        `
      )
      .all(telegramIdHash, limit) as HistoryEntry[];
  }

  getHistoryForGroup(groupId: string, limit = 10): HistoryEntry[] {
    return this.sqlite
      .prepare(
        `
          SELECT
            t.id,
            t.skill,
            t.status,
            t.quoted_price_usdc,
            t.actual_cost_cents,
            t.request_hash,
            t.created_at,
            t.error_code,
            q.is_dev_unquoted
          FROM transactions t
          LEFT JOIN quotes q ON t.quote_id = q.id
          WHERE t.group_id = ?
          ORDER BY t.created_at DESC
          LIMIT ?
        `
      )
      .all(groupId, limit) as HistoryEntry[];
  }

  getDailySpendCentsForGroup(groupId: string, sinceIso: string): number {
    const row = this.sqlite
      .prepare(
        `
          SELECT COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS total
          FROM transactions
          WHERE group_id = ?
            AND created_at >= ?
            AND status IN ('submitted', 'success')
        `
      )
      .get(groupId, sinceIso) as { total: number };

    return row.total;
  }

  createInlinePayload(input: {
    id: string;
    tokenHash: string;
    payloadJson: string;
    signature: string;
    expiresAt: string;
  }): InlinePayloadRow {
    const timestamp = nowIso();

    this.sqlite
      .prepare(
        `
          INSERT INTO inline_payloads (
            id, token_hash, payload_json, signature, created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(input.id, input.tokenHash, input.payloadJson, input.signature, timestamp, input.expiresAt);

    this.createAuditEvent({
      eventName: "inline_payload_created",
      status: "created",
      metadata: { payloadId: input.id }
    });

    return this.getInlinePayload(input.id)!;
  }

  getInlinePayload(id: string): InlinePayloadRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM inline_payloads WHERE id = ?")
      .get(id) as InlinePayloadRow | undefined;
  }

  consumeInlinePayload(id: string, tokenHash: string, now: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE inline_payloads
          SET consumed_at = ?
          WHERE id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        `
      )
      .run(now, id, tokenHash, now) as { changes: number };

    if (result.changes > 0) {
      this.createAuditEvent({
        eventName: "inline_payload_redeemed",
        status: "redeemed",
        metadata: { payloadId: id }
      });
    }

    return result.changes > 0;
  }

  createAuditEvent(input: AuditEventInput): void {
    this.sqlite
      .prepare(
        `
          INSERT INTO audit_events (
            id, event_name, wallet_id, quote_id, transaction_id, actor_hash,
            group_id, status, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        makeId("aud"),
        canonicalAuditEventName(input.eventName, input.status),
        input.walletId || null,
        input.quoteId || null,
        input.transactionId || null,
        input.actorHash || null,
        input.groupId || null,
        input.status || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        nowIso()
      );
  }

  listUnshippedAuditEvents(limit = 50): AuditEventRow[] {
    return this.sqlite
      .prepare(
        `
          SELECT *
          FROM audit_events
          WHERE shipped_at IS NULL
          ORDER BY created_at ASC
          LIMIT ?
        `
      )
      .all(limit) as AuditEventRow[];
  }

  markAuditEventShipped(id: string, sinkName: string, shippedAt = nowIso()): void {
    this.sqlite
      .prepare(
        `
          UPDATE audit_events
          SET shipped_at = ?, sink_name = ?, last_ship_error = NULL
          WHERE id = ? AND shipped_at IS NULL
        `
      )
      .run(shippedAt, sinkName, id);
  }

  markAuditEventShipFailed(id: string, sinkName: string, error: string): void {
    this.sqlite
      .prepare(
        `
          UPDATE audit_events
          SET ship_attempts = ship_attempts + 1,
              last_ship_error = ?,
              sink_name = ?
          WHERE id = ? AND shipped_at IS NULL
        `
      )
      .run(error.slice(0, 512), sinkName, id);
  }

  createPairingCode(input: {
    id: string;
    platform: string;
    actorIdHash: string;
    codeHash: string;
    expiresAt: string;
  }): PairingCodeRow {
    const timestamp = nowIso();
    this.sqlite
      .prepare(
        `
          INSERT INTO gateway_pairing_codes (
            id, platform, actor_id_hash, code_hash, status, created_at, expires_at, approved_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)
        `
      )
      .run(input.id, input.platform, input.actorIdHash, input.codeHash, timestamp, input.expiresAt);

    this.createAuditEvent({
      eventName: "gateway_pairing.code_issued",
      actorHash: input.actorIdHash,
      status: "pending",
      metadata: { platform: input.platform }
    });

    return this.sqlite
      .prepare("SELECT * FROM gateway_pairing_codes WHERE id = ?")
      .get(input.id) as PairingCodeRow;
  }

  getPendingPairingCode(platform: string, actorIdHash: string, now = nowIso()): PairingCodeRow | undefined {
    return this.sqlite
      .prepare(
        `
          SELECT * FROM gateway_pairing_codes
          WHERE platform = ? AND actor_id_hash = ? AND status = 'pending' AND expires_at > ?
          ORDER BY expires_at DESC
          LIMIT 1
        `
      )
      .get(platform, actorIdHash, now) as PairingCodeRow | undefined;
  }

  expireActorPairingCodes(platform: string, actorIdHash: string): void {
    this.sqlite
      .prepare(
        `
          UPDATE gateway_pairing_codes
          SET status = 'expired'
          WHERE platform = ? AND actor_id_hash = ? AND status = 'pending'
        `
      )
      .run(platform, actorIdHash);
  }

  approvePairingCode(id: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE gateway_pairing_codes
          SET status = 'approved', approved_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `
      )
      .run(nowIso(), id, nowIso()) as { changes: number };

    if (result.changes > 0) {
      const row = this.sqlite
        .prepare("SELECT * FROM gateway_pairing_codes WHERE id = ?")
        .get(id) as PairingCodeRow;
      this.createAuditEvent({
        eventName: "gateway_pairing.code_approved",
        actorHash: row.actor_id_hash,
        status: "approved",
        metadata: { platform: row.platform }
      });
    }

    return result.changes > 0;
  }

  revokeActorPairingCodes(platform: string, actorIdHash: string): number {
    const result = this.sqlite
      .prepare(
        `
          UPDATE gateway_pairing_codes
          SET status = 'revoked'
          WHERE platform = ? AND actor_id_hash = ? AND status IN ('pending', 'approved')
        `
      )
      .run(platform, actorIdHash) as { changes: number };

    if (result.changes > 0) {
      this.createAuditEvent({
        eventName: "gateway_pairing.codes_revoked",
        actorHash: actorIdHash,
        status: "revoked",
        metadata: { platform, count: result.changes }
      });
    }

    return result.changes;
  }

  listApprovedPairingActors(platform: string, now = nowIso()): string[] {
    const rows = this.sqlite
      .prepare(
        `
          SELECT DISTINCT actor_id_hash
          FROM gateway_pairing_codes
          WHERE platform = ? AND status = 'approved' AND expires_at > ?
        `
      )
      .all(platform, now) as Array<{ actor_id_hash: string }>;

    return rows.map(r => r.actor_id_hash);
  }

  getWalletPolicy(walletId: string): WalletPolicyRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM wallet_policies WHERE wallet_id = ?")
      .get(walletId) as WalletPolicyRow | undefined;
  }

  upsertWalletPolicy(
    walletId: string,
    input: { dailyCapUsdc?: number | null; weeklyCapUsdc?: number | null; skillAllowlist?: string | null }
  ): WalletPolicyRow {
    const existing = this.getWalletPolicy(walletId);
    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE wallet_policies
           SET daily_cap_usdc = ?, weekly_cap_usdc = ?, skill_allowlist = ?, updated_at = ?
           WHERE wallet_id = ?`
        )
        .run(
          input.dailyCapUsdc !== undefined ? input.dailyCapUsdc : existing.daily_cap_usdc,
          input.weeklyCapUsdc !== undefined ? input.weeklyCapUsdc : existing.weekly_cap_usdc,
          input.skillAllowlist !== undefined ? input.skillAllowlist : existing.skill_allowlist,
          timestamp,
          walletId
        );
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO wallet_policies (id, wallet_id, daily_cap_usdc, weekly_cap_usdc, skill_allowlist, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          makeId("wpl"),
          walletId,
          input.dailyCapUsdc ?? null,
          input.weeklyCapUsdc ?? null,
          input.skillAllowlist ?? null,
          timestamp,
          timestamp
        );
    }

    return this.getWalletPolicy(walletId)!;
  }

  getSkillPolicy(walletId: string, skill: string): SkillPolicyRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM skill_policies WHERE wallet_id = ? AND skill = ?")
      .get(walletId, skill) as SkillPolicyRow | undefined;
  }

  upsertSkillPolicy(walletId: string, skill: string, status: "allowed" | "trusted" | "blocked"): SkillPolicyRow {
    const existing = this.getSkillPolicy(walletId, skill);
    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare("UPDATE skill_policies SET status = ?, updated_at = ? WHERE wallet_id = ? AND skill = ?")
        .run(status, timestamp, walletId, skill);
    } else {
      this.sqlite
        .prepare(
          `INSERT INTO skill_policies (id, wallet_id, skill, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(makeId("spl"), walletId, skill, status, timestamp, timestamp);
    }

    return this.getSkillPolicy(walletId, skill)!;
  }

  getWalletSpendCents(walletId: string, sinceIso: string): number {
    const row = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS total
         FROM transactions
         WHERE wallet_id = ? AND created_at >= ? AND status IN ('submitted', 'success')`
      )
      .get(walletId, sinceIso) as { total: number };
    return row.total;
  }

  hasWalletSucceededTransactions(walletId: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE wallet_id = ? AND status IN ('submitted', 'success') LIMIT 1`
      )
      .get(walletId) as { count: number };
    return row.count > 0;
  }

  recordPolicyDecision(
    quoteId: string,
    walletId: string,
    actorIdHash: string | null,
    decision: { outcome: string; policyType: string; reason: string; snapshotJson: string }
  ): PolicyDecisionRow {
    const id = makeId("pol");
    const timestamp = nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO policy_decisions (id, quote_id, wallet_id, actor_id_hash, outcome, policy_type, reason, snapshot_json, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, quoteId, walletId, actorIdHash, decision.outcome, decision.policyType, decision.reason, decision.snapshotJson, timestamp);

    return this.sqlite.prepare("SELECT * FROM policy_decisions WHERE id = ?").get(id) as PolicyDecisionRow;
  }

  getPolicyDecision(quoteId: string): PolicyDecisionRow | undefined {
    return this.sqlite
      .prepare("SELECT * FROM policy_decisions WHERE quote_id = ?")
      .get(quoteId) as PolicyDecisionRow | undefined;
  }

  // ─── Spend analytics ───────────────────────────────────────────────────────

  private txSpendBySkill(col: "wallet_id" | "group_id", id: string, sinceIso: string): SkillSpendRow[] {
    return this.sqlite
      .prepare(
        `SELECT COALESCE(skill, 'unknown') AS skill,
                COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS cents,
                COUNT(*) AS count
         FROM transactions
         WHERE ${col} = ? AND created_at >= ? AND status IN ('submitted', 'success')
         GROUP BY skill ORDER BY cents DESC`
      )
      .all(id, sinceIso) as SkillSpendRow[];
  }

  getWalletSpendBySkill(walletId: string, sinceIso: string): SkillSpendRow[] {
    return this.txSpendBySkill("wallet_id", walletId, sinceIso);
  }

  getGroupSpendBySkill(groupId: string, sinceIso: string): SkillSpendRow[] {
    return this.txSpendBySkill("group_id", groupId, sinceIso);
  }

  private txSpendByActor(col: "wallet_id" | "group_id", id: string, sinceIso: string): ActorSpendRow[] {
    return this.sqlite
      .prepare(
        `SELECT COALESCE(telegram_id_hash, 'unknown') AS actor_hash,
                COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS cents,
                COUNT(*) AS count
         FROM transactions
         WHERE ${col} = ? AND created_at >= ? AND status IN ('submitted', 'success')
         GROUP BY telegram_id_hash ORDER BY cents DESC LIMIT 20`
      )
      .all(id, sinceIso) as ActorSpendRow[];
  }

  getWalletSpendByActor(walletId: string, sinceIso: string): ActorSpendRow[] {
    return this.txSpendByActor("wallet_id", walletId, sinceIso);
  }

  getGroupSpendByActor(groupId: string, sinceIso: string): ActorSpendRow[] {
    return this.txSpendByActor("group_id", groupId, sinceIso);
  }

  private txSpendByEndpoint(col: "wallet_id" | "group_id", id: string, sinceIso: string): EndpointSpendRow[] {
    return this.sqlite
      .prepare(
        `SELECT COALESCE(endpoint, 'unknown') AS endpoint,
                COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS cents,
                COUNT(*) AS count
         FROM transactions
         WHERE ${col} = ? AND created_at >= ? AND status IN ('submitted', 'success')
         GROUP BY endpoint ORDER BY cents DESC LIMIT 5`
      )
      .all(id, sinceIso) as EndpointSpendRow[];
  }

  getWalletSpendByEndpoint(walletId: string, sinceIso: string): EndpointSpendRow[] {
    return this.txSpendByEndpoint("wallet_id", walletId, sinceIso);
  }

  getGroupSpendByEndpoint(groupId: string, sinceIso: string): EndpointSpendRow[] {
    return this.txSpendByEndpoint("group_id", groupId, sinceIso);
  }

  private txDailySpendSeries(col: "wallet_id" | "group_id", id: string, sinceIso: string): DailySpendRow[] {
    return this.sqlite
      .prepare(
        `SELECT DATE(created_at) AS date,
                COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents, 0)), 0) AS cents
         FROM transactions
         WHERE ${col} = ? AND created_at >= ? AND status IN ('submitted', 'success')
         GROUP BY DATE(created_at) ORDER BY date ASC`
      )
      .all(id, sinceIso) as DailySpendRow[];
  }

  getWalletDailySpendSeries(walletId: string, sinceIso: string): DailySpendRow[] {
    return this.txDailySpendSeries("wallet_id", walletId, sinceIso);
  }

  getGroupDailySpendSeries(groupId: string, sinceIso: string): DailySpendRow[] {
    return this.txDailySpendSeries("group_id", groupId, sinceIso);
  }

  getWalletQuoteStats(walletId: string, sinceIso: string): QuoteStatsRow {
    const total = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM quotes WHERE wallet_id = ? AND created_at >= ?`)
        .get(walletId, sinceIso) as { n: number }
    ).n;
    const succeeded = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM quotes WHERE wallet_id = ? AND created_at >= ? AND status = 'succeeded'`)
        .get(walletId, sinceIso) as { n: number }
    ).n;
    const denied = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE wallet_id = ? AND decided_at >= ? AND outcome LIKE 'deny_%'`)
        .get(walletId, sinceIso) as { n: number }
    ).n;
    return { total, succeeded, denied };
  }

  getGroupQuoteStats(groupId: string, walletId: string, sinceIso: string): QuoteStatsRow {
    const total = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM quotes WHERE group_id = ? AND created_at >= ?`)
        .get(groupId, sinceIso) as { n: number }
    ).n;
    const succeeded = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM quotes WHERE group_id = ? AND created_at >= ? AND status = 'succeeded'`)
        .get(groupId, sinceIso) as { n: number }
    ).n;
    const denied = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE wallet_id = ? AND decided_at >= ? AND outcome LIKE 'deny_%'`)
        .get(walletId, sinceIso) as { n: number }
    ).n;
    return { total, succeeded, denied };
  }

  getWalletFailedTransactionCount(walletId: string, sinceIso: string): number {
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE wallet_id = ? AND created_at >= ? AND status = 'error'`)
      .get(walletId, sinceIso) as { n: number };
    return row.n;
  }

  getGroupFailedTransactionCount(groupId: string, sinceIso: string): number {
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE group_id = ? AND created_at >= ? AND status = 'error'`)
      .get(groupId, sinceIso) as { n: number };
    return row.n;
  }

  getWalletReplayAttemptCount(walletId: string, sinceIso: string): number {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM preflight_attempts
         WHERE wallet_id = ? AND created_at >= ? AND failure_stage = 'replay'`
      )
      .get(walletId, sinceIso) as { n: number };
    return row.n;
  }

  private txEstimatedVsActual(col: "wallet_id" | "group_id", id: string, sinceIso: string): EstimatedVsActualRow {
    const row = this.sqlite
      .prepare(
        `SELECT COALESCE(AVG(estimated_cost_cents), 0) AS estimatedCents,
                COALESCE(AVG(actual_cost_cents), 0) AS actualCents,
                COUNT(*) AS count
         FROM transactions
         WHERE ${col} = ? AND created_at >= ?
           AND status IN ('submitted', 'success')
           AND estimated_cost_cents IS NOT NULL
           AND actual_cost_cents IS NOT NULL`
      )
      .get(id, sinceIso) as EstimatedVsActualRow;
    return row;
  }

  getWalletEstimatedVsActual(walletId: string, sinceIso: string): EstimatedVsActualRow {
    return this.txEstimatedVsActual("wallet_id", walletId, sinceIso);
  }

  getGroupEstimatedVsActual(groupId: string, sinceIso: string): EstimatedVsActualRow {
    return this.txEstimatedVsActual("group_id", groupId, sinceIso);
  }

  getTransactionsForExport(
    filter: { walletId: string } | { groupId: string },
    sinceIso: string,
    limit = 500
  ): TransactionExportRow[] {
    const col = "walletId" in filter ? "wallet_id" : "group_id";
    const id = "walletId" in filter ? filter.walletId : filter.groupId;
    return this.sqlite
      .prepare(
        `SELECT DATE(created_at) AS date,
                COALESCE(skill, 'unknown') AS skill,
                status,
                COALESCE(CAST(estimated_cost_cents AS REAL) / 100, 0) AS estimated_usdc,
                COALESCE(CAST(actual_cost_cents AS REAL) / 100, 0) AS actual_usdc,
                COALESCE(request_hash, '') AS request_hash
         FROM transactions
         WHERE ${col} = ? AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(id, sinceIso, limit) as TransactionExportRow[];
  }

  private executeSchemaStatement(statement: string) {
    try {
      this.sqlite.exec(statement);
    } catch (error) {
      const isIndexStatement = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement);
      const isMissingColumn =
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "SQLITE_ERROR" &&
        /no such column:/i.test(error.message);

      if (isIndexStatement && isMissingColumn) {
        return;
      }

      throw error;
    }
  }

  private ensureWalletColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE wallets ADD COLUMN ${name} ${type}`);
  }

  private ensureUserColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }

  private ensureTransactionColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`);
  }

  private ensureQuoteColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(quotes)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE quotes ADD COLUMN ${name} ${type}`);
  }

  private ensureGroupColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(groups)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE groups ADD COLUMN ${name} ${type}`);
  }

  private ensureAuditEventColumn(name: string, type: string) {
    const columns = this.sqlite.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;

    if (columns.some(column => column.name === name)) {
      return;
    }

    this.sqlite.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${type}`);
  }
}
