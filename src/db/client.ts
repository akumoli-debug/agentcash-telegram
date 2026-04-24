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

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class AppDatabase {
  readonly sqlite: Database.Database;

  constructor(databasePath: string) {
    const resolvedPath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
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
  }

  close() {
    this.sqlite.close();
  }

  upsertUser(input: {
    telegramUserId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    defaultSpendCapUsdc: number;
  }): UserRow {
    const existing = this.getUserByTelegramId(input.telegramUserId);
    const timestamp = nowIso();

    if (existing) {
      this.sqlite
        .prepare(
          `
            UPDATE users
            SET username = ?, first_name = ?, last_name = ?, updated_at = ?
            WHERE telegram_user_id = ?
          `
        )
        .run(
          input.username ?? null,
          input.firstName ?? null,
          input.lastName ?? null,
          timestamp,
          input.telegramUserId
        );

      return this.getUserByTelegramId(input.telegramUserId)!;
    }

    const id = makeId("usr");

    this.sqlite
      .prepare(
        `
          INSERT INTO users (
            id, telegram_user_id, username, first_name, last_name, cap_enabled, default_spend_cap_usdc, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.telegramUserId,
        input.username ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        1,
        input.defaultSpendCapUsdc,
        timestamp,
        timestamp
      );

    return this.getUserByTelegramId(input.telegramUserId)!;
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
            skill, origin, endpoint, status, quoted_price_usdc, actual_price_usdc, estimated_cost_cents, actual_cost_cents, tx_hash,
            request_hash, response_hash, request_summary, response_summary, error_code, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              command_name = ?, skill = ?, origin = ?, endpoint = ?, status = ?, quoted_price_usdc = ?,
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
