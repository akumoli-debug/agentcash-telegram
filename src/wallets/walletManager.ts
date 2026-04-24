import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import { AppDatabase, type GroupMemberRow, type GroupRow, type UserRow, type WalletRow } from "../db/client.js";
import { AgentCashClient } from "../agentcash/agentcashClient.js";
import { hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import { AgentCashError, NotFoundError } from "../lib/errors.js";
import { defaultLockManager, type LockManager } from "../lib/lockManager.js";

const WALLET_LOCK_TTL_MS = 120_000;

export interface TelegramProfile {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface WalletContextResult {
  user: UserRow;
  wallet: WalletRow;
  group?: GroupRow;
  member?: GroupMemberRow;
}

export interface TelegramGroupContext {
  chatId: string;
  title?: string | null;
  createdByTelegramId: string;
  creatorProfile?: TelegramProfile;
}

export class WalletManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly agentcashClient: AgentCashClient,
    private readonly lockManager: LockManager = defaultLockManager
  ) {}

  /**
   * Provisions or retrieves the wallet for a Telegram user.
   * Per-user locking prevents duplicate CLI provisioning calls.
   * DB unique constraints enforce idempotency at the storage layer.
   */
  async getOrCreateWalletForTelegramUser(
    telegramId: string,
    profile?: TelegramProfile
  ): Promise<WalletContextResult> {
    const homeDirHash = WalletManager.getHashedHomeDirName(telegramId, this.config.MASTER_ENCRYPTION_KEY);
    const userHash = homeDirHash;

    return this.lockManager.withLock(`wallet:user:${userHash}`, WALLET_LOCK_TTL_MS, async () => {
      const user = this.db.upsertUser({
        telegramUserId: telegramId,
        defaultSpendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC
      });

      let wallet = this.db.getWalletByUserId(user.id);

      if (!wallet) {
        wallet = this.db.createUserWallet(user.id, { homeDirHash, status: "pending" });
      }

      if (!wallet.home_dir_hash) {
        wallet = this.db.updateWallet(wallet.id, { homeDirHash });
      }

      if (
        wallet.status === "active" &&
        wallet.address &&
        wallet.encrypted_private_key &&
        wallet.home_dir_hash
      ) {
        return { user, wallet };
      }

      const ensuredWallet = await this.agentcashClient.ensureWallet(wallet);

      if (ensuredWallet.encryptedPrivateKey) {
        const existingKey = wallet.encrypted_private_key;
        if (existingKey && existingKey !== ensuredWallet.encryptedPrivateKey) {
          throw new AgentCashError(
            "Wallet key material mismatch — refusing to overwrite existing encrypted key"
          );
        }
      }

      wallet = this.db.updateWallet(wallet.id, {
        homeDirHash,
        address: ensuredWallet.address ?? wallet.address,
        network: ensuredWallet.network ?? wallet.network,
        depositLink: ensuredWallet.depositLink ?? wallet.deposit_link,
        encryptedPrivateKey: ensuredWallet.encryptedPrivateKey ?? wallet.encrypted_private_key,
        status: "active"
      });

      return { user, wallet };
    });
  }

  /**
   * Provisions or retrieves the wallet for a Telegram group.
   * The wallet remains a normal wallets.kind='group' row.
   */
  async getOrCreateGroupWallet(input: TelegramGroupContext): Promise<WalletContextResult> {
    const chatHash = WalletManager.getHashedChatId(input.chatId, this.config.MASTER_ENCRYPTION_KEY);
    const homeDirHash = WalletManager.getHashedGroupHomeDirName(input.chatId, this.config.MASTER_ENCRYPTION_KEY);

    return this.lockManager.withLock(`wallet:group:${chatHash}`, WALLET_LOCK_TTL_MS, async () => {
      const user = this.db.upsertUser({
        telegramUserId: input.createdByTelegramId,
        defaultSpendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC
      });

      let group = this.db.getGroupByTelegramChatHash(chatHash);
      let wallet = group ? this.db.getWalletById(group.wallet_id) : undefined;
      let member = group ? this.db.ensureGroupMember(group.id, user.id, "member") : undefined;

      if (!group || !wallet) {
        const created = this.db.createGroupWithWallet({
          telegramChatIdHash: chatHash,
          titleHash: input.title
            ? hashSensitiveValue(`title:${input.title}`, this.config.MASTER_ENCRYPTION_KEY).slice(0, 24)
            : null,
          createdByUserId: user.id,
          spendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC,
          homeDirHash
        });
        group = created.group;
        wallet = created.wallet;
        member = created.member;
      }

      if (!wallet.home_dir_hash) {
        wallet = this.db.updateWallet(wallet.id, { homeDirHash });
      }

      if (
        wallet.status === "active" &&
        wallet.address &&
        wallet.encrypted_private_key &&
        wallet.home_dir_hash
      ) {
        return { user, wallet, group, member };
      }

      const ensuredWallet = await this.agentcashClient.ensureWallet(wallet);

      if (ensuredWallet.encryptedPrivateKey) {
        const existingKey = wallet.encrypted_private_key;
        if (existingKey && existingKey !== ensuredWallet.encryptedPrivateKey) {
          throw new AgentCashError(
            "Wallet key material mismatch — refusing to overwrite existing encrypted key"
          );
        }
      }

      wallet = this.db.updateWallet(wallet.id, {
        homeDirHash,
        address: ensuredWallet.address ?? wallet.address,
        network: ensuredWallet.network ?? wallet.network,
        depositLink: ensuredWallet.depositLink ?? wallet.deposit_link,
        encryptedPrivateKey: ensuredWallet.encryptedPrivateKey ?? wallet.encrypted_private_key,
        status: "active"
      });

      return { user, wallet, group, member };
    });
  }

  async getGroupWalletForTelegramChat(
    chatId: string,
    requesterTelegramId: string
  ): Promise<WalletContextResult | null> {
    const chatHash = WalletManager.getHashedChatId(chatId, this.config.MASTER_ENCRYPTION_KEY);
    const group = this.db.getGroupByTelegramChatHash(chatHash);
    if (!group) {
      return null;
    }

    const user = this.db.upsertUser({
      telegramUserId: requesterTelegramId,
      defaultSpendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC
    });
    const member = this.db.ensureGroupMember(group.id, user.id, "member");
    const wallet = this.db.getWalletById(group.wallet_id);
    if (!wallet) {
      throw new NotFoundError("Group wallet not found.");
    }

    return { user, wallet, group, member };
  }

  async getBalance(
    telegramId: string,
    profile?: TelegramProfile
  ): Promise<WalletContextResult & { balance: Awaited<ReturnType<AgentCashClient["getBalance"]>> }> {
    const { user, wallet } = await this.getOrCreateWalletForTelegramUser(telegramId, profile);
    const balance = await this.agentcashClient.getBalance(wallet);
    const updatedWallet = this.db.updateWallet(wallet.id, {
      address: balance.address ?? wallet.address,
      network: balance.network ?? wallet.network,
      depositLink: balance.depositLink ?? wallet.deposit_link
    });

    return { user, wallet: updatedWallet, balance };
  }

  async getGroupBalance(
    chatId: string,
    requesterTelegramId: string
  ): Promise<WalletContextResult & { balance: Awaited<ReturnType<AgentCashClient["getBalance"]>> }> {
    const context = await this.getGroupWalletForTelegramChat(chatId, requesterTelegramId);
    if (!context) {
      throw new NotFoundError("No group wallet exists yet. Run /groupwallet create in this group first.");
    }

    const balance = await this.agentcashClient.getBalance(context.wallet);
    const updatedWallet = this.db.updateWallet(context.wallet.id, {
      address: balance.address ?? context.wallet.address,
      network: balance.network ?? context.wallet.network,
      depositLink: balance.depositLink ?? context.wallet.deposit_link
    });

    return { ...context, wallet: updatedWallet, balance };
  }

  async getDepositAddress(
    telegramId: string,
    profile?: TelegramProfile
  ): Promise<WalletContextResult & { deposit: Awaited<ReturnType<AgentCashClient["getDepositInfo"]>> }> {
    const { user, wallet } = await this.getOrCreateWalletForTelegramUser(telegramId, profile);
    const deposit = await this.agentcashClient.getDepositInfo(wallet);
    const updatedWallet = this.db.updateWallet(wallet.id, {
      address: deposit.address ?? wallet.address,
      network: deposit.network ?? wallet.network,
      depositLink: deposit.depositLink ?? wallet.deposit_link
    });

    return { user, wallet: updatedWallet, deposit };
  }

  async getGroupDepositAddress(
    chatId: string,
    requesterTelegramId: string
  ): Promise<WalletContextResult & { deposit: Awaited<ReturnType<AgentCashClient["getDepositInfo"]>> }> {
    const context = await this.getGroupWalletForTelegramChat(chatId, requesterTelegramId);
    if (!context) {
      throw new NotFoundError("No group wallet exists yet. Run /groupwallet create in this group first.");
    }

    const deposit = await this.agentcashClient.getDepositInfo(context.wallet);
    const updatedWallet = this.db.updateWallet(context.wallet.id, {
      address: deposit.address ?? context.wallet.address,
      network: deposit.network ?? context.wallet.network,
      depositLink: deposit.depositLink ?? context.wallet.deposit_link
    });

    return { ...context, wallet: updatedWallet, deposit };
  }

  getSpendCap(user: UserRow): number {
    return user.default_spend_cap_usdc ?? this.config.DEFAULT_SPEND_CAP_USDC;
  }

  getConfirmationCap(user: UserRow): number | undefined {
    if (!user.cap_enabled) {
      return undefined;
    }
    return user.default_spend_cap_usdc ?? this.config.DEFAULT_SPEND_CAP_USDC;
  }

  getGroupConfirmationCap(group: GroupRow): number | undefined {
    if (!group.cap_enabled) {
      return undefined;
    }
    return group.spend_cap_usdc ?? this.config.DEFAULT_SPEND_CAP_USDC;
  }

  updateUserCap(telegramId: string, input: { amount?: number; enabled?: boolean }): UserRow {
    const user = this.getExistingUser(telegramId);
    return this.db.updateUserCap(user.id, input);
  }

  updateGroupCap(groupId: string, input: { amount?: number; enabled?: boolean }): GroupRow {
    return this.db.updateGroupCap(groupId, input);
  }

  isGroupAdmin(groupId: string, userId: string): boolean {
    const member = this.db.getGroupMember(groupId, userId);
    return member?.role === "owner" || member?.role === "admin";
  }

  async getDepositQrDataUrl(address: string): Promise<string> {
    return QRCode.toDataURL(address, { margin: 1, width: 256 });
  }

  getExistingUser(telegramId: string): UserRow {
    const user = this.db.getUserByTelegramId(telegramId);
    if (!user) {
      throw new NotFoundError("Telegram user has not started the bot yet");
    }
    return user;
  }

  static getHashedHomeDirName(telegramId: string, masterKey: string): string {
    return hashTelegramId(telegramId, masterKey);
  }

  static getHashedChatId(chatId: string, masterKey: string): string {
    return hashSensitiveValue(`chat:${chatId}`, masterKey).slice(0, 24);
  }

  static getHashedGroupHomeDirName(chatId: string, masterKey: string): string {
    return hashSensitiveValue(`group-wallet:${chatId}`, masterKey).slice(0, 24);
  }

  static maskAddress(address: string | null | undefined): string {
    if (!address) return "not provisioned";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
