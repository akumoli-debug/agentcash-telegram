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
  encrypted_private_key: string | null;
  status: "pending" | "active" | "disabled";
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
  status: "pending" | "approved" | "executed" | "expired" | "cancelled" | "failed";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  executed_at: string | null;
  transaction_id: string | null;
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
}

export interface HistoryEntry {
  id: string;
  skill: string | null;
  status: string;
  quoted_price_usdc: number | null;
  actual_cost_cents: number | null;
  created_at: string;
  error_code: string | null;
  is_dev_unquoted: number | null;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
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
    this.ensureUserColumn("cap_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureTransactionColumn("telegram_id_hash", "TEXT");
    this.ensureTransactionColumn("skill", "TEXT");
    this.ensureTransactionColumn("estimated_cost_cents", "INTEGER");
    this.ensureTransactionColumn("actual_cost_cents", "INTEGER");
    this.ensureTransactionColumn("request_hash", "TEXT");
    this.ensureTransactionColumn("response_hash", "TEXT");
    this.ensureTransactionColumn("quote_id", "TEXT");
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
        transaction_id TEXT
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

  createUserWallet(
    userId: string,
    input: {
      homeDirHash: string;
      address?: string | null;
      network?: string | null;
      depositLink?: string | null;
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
            id, kind, owner_user_id, owner_group_id, home_dir_hash, address, network, deposit_link, encrypted_private_key, status, created_at, updated_at
          ) VALUES (?, 'user', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        userId,
        input.homeDirHash,
        input.address ?? null,
        input.network ?? null,
        input.depositLink ?? null,
        input.encryptedPrivateKey ?? null,
        input.status ?? "pending",
        timestamp,
        timestamp
      );

    return this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow;
  }

  updateWallet(
    id: string,
    input: {
      homeDirHash?: string | null;
      address?: string | null;
      network?: string | null;
      depositLink?: string | null;
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
          SET home_dir_hash = ?, address = ?, network = ?, deposit_link = ?, encrypted_private_key = ?, status = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.homeDirHash ?? current.home_dir_hash,
        input.address ?? current.address,
        input.network ?? current.network,
        input.depositLink ?? current.deposit_link,
        input.encryptedPrivateKey ?? current.encrypted_private_key,
        input.status ?? current.status,
        nowIso(),
        id
      );

    return this.sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow;
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
            created_at, expires_at, approved_at, executed_at, transaction_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)
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
        input.expiresAt
      );

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
            id, user_id, wallet_id, session_id, telegram_chat_id, telegram_message_id, telegram_id_hash, command_name,
            skill, origin, endpoint, quote_id, status, quoted_price_usdc, actual_price_usdc, estimated_cost_cents, actual_cost_cents, tx_hash,
            request_hash, response_hash, request_summary, response_summary, error_code, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.requestHash ?? null,
        input.responseHash ?? null,
        input.requestSummary ?? null,
        input.responseSummary ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        timestamp,
        timestamp
      );

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
          SET wallet_id = ?, session_id = ?, telegram_chat_id = ?, telegram_message_id = ?, telegram_id_hash = ?,
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
}
