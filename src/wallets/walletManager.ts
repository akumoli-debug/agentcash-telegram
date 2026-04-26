import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import { AppDatabase, type GroupMemberRow, type GroupRow, type UserRow, type WalletRow } from "../db/client.js";
import { AgentCashClient } from "../agentcash/agentcashClient.js";
import { hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import { AgentCashError, NotFoundError } from "../lib/errors.js";
import { defaultLockManager, type LockManager } from "../lib/lockManager.js";

const WALLET_LOCK_TTL_MS = 120_000;

export type TelegramProfile = Record<string, never>;

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

export interface DiscordGuildContext {
  guildId: string;
  createdByDiscordId: string;
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
        wallet = this.db.createUserWallet(user.id, {
          homeDirHash,
          walletRef: homeDirHash,
          signerBackend: this.custodyMode(),
          status: "pending"
        });
      }

      if (!wallet.home_dir_hash) {
        wallet = this.db.updateWallet(wallet.id, { homeDirHash });
      }

      if (
        (wallet.status === "active" || wallet.status === "disabled") &&
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
        walletRef: wallet.wallet_ref ?? homeDirHash,
        signerBackend: wallet.signer_backend ?? this.custodyMode(),
        address: ensuredWallet.address ?? wallet.address,
        publicAddress: ensuredWallet.address ?? wallet.public_address ?? wallet.address,
        network: ensuredWallet.network ?? wallet.network,
        depositLink: ensuredWallet.depositLink ?? wallet.deposit_link,
        encryptedPrivateKey: ensuredWallet.encryptedPrivateKey ?? wallet.encrypted_private_key,
        status: "active"
      });

      this.db.recordWalletKeyIfMissing({
        walletId: wallet.id,
        encryptedPrivateKey: wallet.encrypted_private_key,
        signerBackend: wallet.signer_backend,
        publicAddress: wallet.public_address ?? wallet.address
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
          homeDirHash,
          signerBackend: this.custodyMode()
        });
        group = created.group;
        wallet = created.wallet;
        member = created.member;
      }

      if (!wallet.home_dir_hash) {
        wallet = this.db.updateWallet(wallet.id, { homeDirHash });
      }

      if (
        (wallet.status === "active" || wallet.status === "disabled") &&
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
        walletRef: wallet.wallet_ref ?? homeDirHash,
        signerBackend: wallet.signer_backend ?? this.custodyMode(),
        address: ensuredWallet.address ?? wallet.address,
        publicAddress: ensuredWallet.address ?? wallet.public_address ?? wallet.address,
        network: ensuredWallet.network ?? wallet.network,
        depositLink: ensuredWallet.depositLink ?? wallet.deposit_link,
        encryptedPrivateKey: ensuredWallet.encryptedPrivateKey ?? wallet.encrypted_private_key,
        status: "active"
      });

      this.db.recordWalletKeyIfMissing({
        walletId: wallet.id,
        encryptedPrivateKey: wallet.encrypted_private_key,
        signerBackend: wallet.signer_backend,
        publicAddress: wallet.public_address ?? wallet.address
      });

      return { user, wallet, group, member };
    });
  }

  async getOrCreateDiscordGuildWallet(input: DiscordGuildContext): Promise<WalletContextResult> {
    const guildHash = WalletManager.getHashedDiscordGuildId(input.guildId, this.config.MASTER_ENCRYPTION_KEY);
    const homeDirHash = WalletManager.getHashedDiscordGuildHomeDirName(input.guildId, this.config.MASTER_ENCRYPTION_KEY);

    return this.lockManager.withLock(`wallet:discord:guild:${guildHash}`, WALLET_LOCK_TTL_MS, async () => {
      const user = this.db.upsertUser({
        telegramUserId: `discord:${input.createdByDiscordId}`,
        defaultSpendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC
      });

      let group = this.db.getGroupByDiscordGuildHash(guildHash);
      let wallet = group ? this.db.getWalletById(group.wallet_id) : undefined;
      let member = group ? this.db.ensureGroupMember(group.id, user.id, "member") : undefined;

      if (!group || !wallet) {
        const created = this.db.createGroupWithWallet({
          telegramChatIdHash: guildHash,
          platform: "discord",
          guildIdHash: guildHash,
          createdByUserId: user.id,
          spendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC,
          homeDirHash,
          signerBackend: this.custodyMode()
        });
        group = created.group;
        wallet = created.wallet;
        member = created.member;
      }

      if (!wallet.home_dir_hash) {
        wallet = this.db.updateWallet(wallet.id, { homeDirHash });
      }

      if (
        (wallet.status === "active" || wallet.status === "disabled") &&
        wallet.address &&
        wallet.encrypted_private_key &&
        wallet.home_dir_hash
      ) {
        return { user, wallet, group, member };
      }

      const ensuredWallet = await this.agentcashClient.ensureWallet(wallet);
      wallet = this.db.updateWallet(wallet.id, {
        homeDirHash,
        walletRef: wallet.wallet_ref ?? homeDirHash,
        signerBackend: wallet.signer_backend ?? this.custodyMode(),
        address: ensuredWallet.address ?? wallet.address,
        publicAddress: ensuredWallet.address ?? wallet.public_address ?? wallet.address,
        network: ensuredWallet.network ?? wallet.network,
        depositLink: ensuredWallet.depositLink ?? wallet.deposit_link,
        encryptedPrivateKey: ensuredWallet.encryptedPrivateKey ?? wallet.encrypted_private_key,
        status: "active"
      });

      this.db.recordWalletKeyIfMissing({
        walletId: wallet.id,
        encryptedPrivateKey: wallet.encrypted_private_key,
        signerBackend: wallet.signer_backend,
        publicAddress: wallet.public_address ?? wallet.address
      });

      return { user, wallet, group, member };
    });
  }

  async getDiscordGuildWalletForGuild(
    guildId: string,
    requesterDiscordId: string
  ): Promise<WalletContextResult | null> {
    const guildHash = WalletManager.getHashedDiscordGuildId(guildId, this.config.MASTER_ENCRYPTION_KEY);
    const group = this.db.getGroupByDiscordGuildHash(guildHash);
    if (!group) {
      return null;
    }

    const user = this.db.upsertUser({
      telegramUserId: `discord:${requesterDiscordId}`,
      defaultSpendCapUsdc: this.config.DEFAULT_SPEND_CAP_USDC
    });
    const member = this.db.ensureGroupMember(group.id, user.id, "member");
    const wallet = this.db.getWalletById(group.wallet_id);
    if (!wallet) {
      throw new NotFoundError("Discord guild wallet not found.");
    }

    return { user, wallet, group, member };
  }

  async getDiscordGuildBalance(
    guildId: string,
    requesterDiscordId: string
  ): Promise<WalletContextResult & { balance: Awaited<ReturnType<AgentCashClient["getBalance"]>> }> {
    const context = await this.getDiscordGuildWalletForGuild(guildId, requesterDiscordId);
    if (!context) {
      throw new NotFoundError("No Discord guild wallet exists yet. Run /ac guild create first.");
    }

    const balance = await this.agentcashClient.getBalance(context.wallet);
    const updatedWallet = this.db.updateWallet(context.wallet.id, {
      address: balance.address ?? context.wallet.address,
      network: balance.network ?? context.wallet.network,
      depositLink: balance.depositLink ?? context.wallet.deposit_link
    });

    return { ...context, wallet: updatedWallet, balance };
  }

  async getDiscordGuildDepositAddress(
    guildId: string,
    requesterDiscordId: string
  ): Promise<WalletContextResult & { deposit: Awaited<ReturnType<AgentCashClient["getDepositInfo"]>> }> {
    const context = await this.getDiscordGuildWalletForGuild(guildId, requesterDiscordId);
    if (!context) {
      throw new NotFoundError("No Discord guild wallet exists yet. Run /ac guild create first.");
    }

    const deposit = await this.agentcashClient.getDepositInfo(context.wallet);
    const updatedWallet = this.db.updateWallet(context.wallet.id, {
      address: deposit.address ?? context.wallet.address,
      network: deposit.network ?? context.wallet.network,
      depositLink: deposit.depositLink ?? context.wallet.deposit_link
    });

    return { ...context, wallet: updatedWallet, deposit };
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

  freezeUserWallet(telegramId: string): WalletRow {
    const user = this.getExistingUser(telegramId);
    const wallet = this.db.getWalletByUserId(user.id);
    if (!wallet) {
      throw new NotFoundError("Wallet has not been created yet");
    }
    return this.db.updateWallet(wallet.id, { status: "disabled" });
  }

  unfreezeUserWallet(telegramId: string): WalletRow {
    const user = this.getExistingUser(telegramId);
    const wallet = this.db.getWalletByUserId(user.id);
    if (!wallet) {
      throw new NotFoundError("Wallet has not been created yet");
    }
    return this.db.updateWallet(wallet.id, { status: "active" });
  }

  getUserWalletStatus(telegramId: string): WalletRow | undefined {
    const user = this.db.getUserByTelegramId(telegramId);
    return user ? this.db.getWalletByUserId(user.id) : undefined;
  }

  freezeGroupWallet(groupId: string): WalletRow {
    const wallet = this.db.getWalletByGroupId(groupId);
    if (!wallet) {
      throw new NotFoundError("Group wallet has not been created yet");
    }
    return this.db.updateWallet(wallet.id, { status: "disabled" });
  }

  unfreezeGroupWallet(groupId: string): WalletRow {
    const wallet = this.db.getWalletByGroupId(groupId);
    if (!wallet) {
      throw new NotFoundError("Group wallet has not been created yet");
    }
    return this.db.updateWallet(wallet.id, { status: "active" });
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

  static getHashedDiscordGuildId(guildId: string, masterKey: string): string {
    return hashSensitiveValue(`discord:guild:${guildId}`, masterKey).slice(0, 24);
  }

  static getHashedDiscordGuildHomeDirName(guildId: string, masterKey: string): string {
    return hashSensitiveValue(`discord-guild-wallet:${guildId}`, masterKey).slice(0, 24);
  }

  static maskAddress(address: string | null | undefined): string {
    if (!address) return "not provisioned";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  private custodyMode(): string {
    return this.config.CUSTODY_MODE ?? "local_cli";
  }
}
