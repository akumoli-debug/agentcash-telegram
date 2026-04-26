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
  status: "pending" | "approved" | "executing" | "succeeded" | "expired" | "canceled" | "failed";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  executed_at: string | null;
  transaction_id: string | null;
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
    executing: ["succeeded", "failed"],
    succeeded: [],
    failed: [],
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
      this.sqlite.exec(statement);
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
    this.ensureGroupColumn("platform", "TEXT NOT NULL DEFAULT 'telegram'");
    this.ensureGroupColumn("guild_id_hash", "TEXT");
    this.ensureGroupColumn("cap_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureGroupColumn("spend_cap_usdc", "REAL NOT NULL DEFAULT 0.5");
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

  atomicBeginQuoteExecution(id: string): boolean {
    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = 'executing'
          WHERE id = ? AND status = 'approved' AND expires_at > ?
        `
      )
      .run(id, nowIso()) as { changes: number };

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

  updateQuoteStatus(
    id: string,
    status: QuoteRow["status"],
    extras?: { executedAt?: string; transactionId?: string }
  ): void {
    this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = ?, executed_at = COALESCE(?, executed_at), transaction_id = COALESCE(?, transaction_id)
          WHERE id = ?
        `
      )
      .run(status, extras?.executedAt ?? null, extras?.transactionId ?? null, id);

    if (status === "expired" || status === "canceled" || status === "failed") {
      const quote = this.getQuote(id);
      this.createAuditEvent({
        eventName: status === "expired" ? "quote.expired" : "quote.rejected",
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
    extras?: { executedAt?: string; transactionId?: string }
  ): boolean {
    if (!isValidQuoteTransition(from, to)) {
      return false;
    }

    const result = this.sqlite
      .prepare(
        `
          UPDATE quotes
          SET status = ?, executed_at = COALESCE(?, executed_at), transaction_id = COALESCE(?, transaction_id)
          WHERE id = ? AND status = ?
        `
      )
      .run(to, extras?.executedAt ?? null, extras?.transactionId ?? null, id, from) as { changes: number };

    if (result.changes > 0) {
      const quote = this.getQuote(id);
      const eventName =
        to === "succeeded"
          ? "quote_execution_succeeded"
          : to === "failed"
          ? "quote_execution_failed"
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

    if (input.status === "submitted") {
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
}
