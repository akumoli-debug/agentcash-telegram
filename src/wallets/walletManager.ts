import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import { AppDatabase, type UserRow, type WalletRow } from "../db/client.js";
import { AgentCashClient } from "../agentcash/agentcashClient.js";
import { hashTelegramId } from "../lib/crypto.js";
import { AgentCashError, NotFoundError } from "../lib/errors.js";
import { withUserLock } from "../lib/userLock.js";

export interface TelegramProfile {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface WalletContextResult {
  user: UserRow;
  wallet: WalletRow;
}

export class WalletManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly agentcashClient: AgentCashClient
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

    return withUserLock(userHash, async () => {
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

  getSpendCap(user: UserRow): number {
    return user.default_spend_cap_usdc ?? this.config.DEFAULT_SPEND_CAP_USDC;
  }

  getConfirmationCap(user: UserRow): number | undefined {
    if (!user.cap_enabled) {
      return undefined;
    }
    return user.default_spend_cap_usdc ?? this.config.DEFAULT_SPEND_CAP_USDC;
  }

  updateUserCap(telegramId: string, input: { amount?: number; enabled?: boolean }): UserRow {
    const user = this.getExistingUser(telegramId);
    return this.db.updateUserCap(user.id, input);
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

  static maskAddress(address: string | null | undefined): string {
    if (!address) return "not provisioned";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
