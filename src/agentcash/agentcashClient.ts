import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { WalletRow } from "../db/client.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { AgentCashError, TimeoutError } from "../lib/errors.js";

export interface AgentCashBalanceResult {
  address?: string;
  network?: string;
  usdcBalance?: number;
  depositLink?: string;
  raw: unknown;
}

export interface AgentCashDepositResult {
  address?: string;
  network?: string;
  depositLink?: string;
  raw: unknown;
}

export interface AgentCashWalletResult extends AgentCashDepositResult {
  encryptedPrivateKey?: string;
}

export interface AgentCashCheckResult {
  estimatedCostCents?: number;
  raw: unknown;
}

export interface AgentCashFetchResult {
  raw: unknown;
  data: unknown;
  actualCostCents?: number;
  txHash?: string;
}

interface WalletCommandInput {
  wallet: WalletRow;
  homeDir: string;
}

export class AgentCashClient {
  constructor(private readonly config: AppConfig) {}

  async ensureWallet(wallet: WalletRow): Promise<AgentCashWalletResult> {
    const homeDir = this.getHomeDir(wallet);
    const raw = await this.runJsonCommand(["accounts"], { wallet, homeDir });
    const capturedWallet = this.captureWalletFile(homeDir);
    const encryptedPrivateKey =
      wallet.encrypted_private_key ??
      (capturedWallet?.privateKey
        ? encryptSecret(capturedWallet.privateKey, this.config.MASTER_ENCRYPTION_KEY)
        : undefined);

    const result: AgentCashWalletResult = {
      address: this.pickAddress(raw) ?? capturedWallet?.address ?? wallet.address ?? undefined,
      network: this.pickNetwork(raw) ?? wallet.network ?? undefined,
      depositLink: this.pickDepositLink(raw) ?? wallet.deposit_link ?? undefined,
      encryptedPrivateKey,
      raw
    };

    this.cleanupWalletArtifacts(homeDir);

    if (!result.address) {
      throw new AgentCashError("AgentCash did not return a wallet address");
    }

    if (!result.encryptedPrivateKey) {
      throw new AgentCashError("AgentCash wallet secret could not be secured");
    }

    return result;
  }

  async getBalance(wallet: WalletRow): Promise<AgentCashBalanceResult> {
    const raw = await this.runJsonCommand(["balance"], {
      wallet,
      homeDir: this.getHomeDir(wallet)
    });

    return {
      raw,
      usdcBalance: this.extractPriceLikeValue(raw, ["usdcBalance", "usdc_balance", "balance", "amount"]),
      address: this.pickAddress(raw) ?? wallet.address ?? undefined,
      network: this.pickNetwork(raw) ?? wallet.network ?? undefined,
      depositLink: this.pickDepositLink(raw) ?? wallet.deposit_link ?? undefined
    };
  }

  async getDepositInfo(wallet: WalletRow): Promise<AgentCashDepositResult> {
    const raw = await this.runJsonCommand(["accounts"], {
      wallet,
      homeDir: this.getHomeDir(wallet)
    });

    return {
      raw,
      address: this.pickAddress(raw) ?? wallet.address ?? undefined,
      network: this.pickNetwork(raw) ?? wallet.network ?? undefined,
      depositLink: this.pickDepositLink(raw) ?? wallet.deposit_link ?? undefined
    };
  }

  async checkEndpoint(
    wallet: WalletRow,
    url: string,
    body?: Record<string, unknown>
  ): Promise<AgentCashCheckResult> {
    const args = ["check", url];

    if (body) {
      args.push("-m", "POST", "-b", JSON.stringify(body));
    }

    const raw = await this.runJsonCommand(args, {
      wallet,
      homeDir: this.getHomeDir(wallet)
    });

    return {
      raw,
      estimatedCostCents: this.extractCostCents(raw)
    };
  }

  async fetchJson(
    wallet: WalletRow,
    url: string,
    body?: Record<string, unknown>
  ): Promise<AgentCashFetchResult> {
    const args = ["fetch", url];

    if (body) {
      args.push("-m", "POST", "-b", JSON.stringify(body));
    }

    const raw = await this.runJsonCommand(args, {
      wallet,
      homeDir: this.getHomeDir(wallet)
    });

    return {
      raw,
      data: this.unwrapData(raw),
      actualCostCents: this.extractCostCents(raw),
      txHash: this.pickTransactionHash(raw)
    };
  }

  async pollJob(
    wallet: WalletRow,
    url: string,
    options?: { intervalMs?: number; timeoutMs?: number }
  ): Promise<AgentCashFetchResult> {
    const intervalMs = options?.intervalMs ?? 3_000;
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const result = await this.fetchJson(wallet, url);
      const dataObject = this.asObject(result.data);
      const status = String(dataObject?.status ?? dataObject?.state ?? "").toLowerCase();

      if (this.extractImageUrl(result.data) || this.extractJobLink(result.data)) {
        return result;
      }

      if (status && ["completed", "complete", "succeeded", "success", "finished"].includes(status)) {
        return result;
      }

      if (status && ["failed", "error", "cancelled"].includes(status)) {
        throw new AgentCashError("Generation job failed", { status, raw: result.raw });
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new TimeoutError("Timed out waiting for AgentCash job result");
  }

  getHomeDir(wallet: WalletRow): string {
    if (!wallet.home_dir_hash) {
      throw new AgentCashError("Wallet is missing isolated home metadata");
    }

    const homeDir = path.resolve(this.config.AGENTCASH_HOME_ROOT, wallet.home_dir_hash);
    fs.mkdirSync(homeDir, { recursive: true });
    return homeDir;
  }

  extractCostCents(raw: unknown): number | undefined {
    const directPrice = this.extractPriceLikeValue(raw, ["price", "estimatedPrice", "cost", "amount"]);

    if (typeof directPrice === "number") {
      return Math.round(directPrice * 100);
    }

    const paymentMethods = this.findArrayByKey(raw, ["paymentMethods", "payment_methods"]);
    if (paymentMethods) {
      for (const item of paymentMethods) {
        const price = this.extractPriceLikeValue(item, ["price", "amount"]);
        if (typeof price === "number") {
          return Math.round(price * 100);
        }
      }
    }

    return undefined;
  }

  extractImageUrl(raw: unknown): string | undefined {
    return this.findStringByKey(raw, ["imageUrl", "image_url", "url"]);
  }

  extractJobId(raw: unknown): string | undefined {
    return this.findStringByKey(raw, ["jobId", "job_id"]);
  }

  extractJobLink(raw: unknown): string | undefined {
    return this.findStringByKey(raw, ["videoUrl", "video_url", "link"]);
  }

  private runJsonCommand(args: string[], input: WalletCommandInput): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const fullArgs = [...this.config.agentcashArgs, ...args, "--format", "json"];
      const child = spawn(this.config.AGENTCASH_COMMAND, fullArgs, {
        env: this.buildCommandEnv(input.wallet, input.homeDir),
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.config.AGENTCASH_TIMEOUT_MS);

      child.stdout.on("data", chunk => {
        stdout += String(chunk);
      });

      child.stderr.on("data", chunk => {
        stderr += String(chunk);
      });

      child.on("error", error => {
        clearTimeout(timeout);
        reject(new AgentCashError("Failed to start AgentCash command", { cause: error.message }));
      });

      child.on("close", code => {
        clearTimeout(timeout);

        if (code === null) {
          reject(new TimeoutError("AgentCash command timed out"));
          return;
        }

        if (code !== 0) {
          reject(
            new AgentCashError("AgentCash command failed", {
              code,
              stderr: stderr.trim()
            })
          );
          return;
        }

        try {
          resolve(this.parseJson(stdout));
        } catch {
          reject(
            new AgentCashError("AgentCash command returned invalid JSON", {
              stdout: stdout.trim(),
              stderr: stderr.trim()
            })
          );
        }
      });
    });
  }

  private buildCommandEnv(wallet: WalletRow, homeDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTCASH_HOME: homeDir,
      HOME: homeDir
    };

    if (wallet.encrypted_private_key) {
      env.X402_PRIVATE_KEY = decryptSecret(
        wallet.encrypted_private_key,
        this.config.MASTER_ENCRYPTION_KEY
      );
    }

    return env;
  }

  private parseJson(stdout: string): Record<string, unknown> {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      const lines = trimmed.split("\n").reverse();
      for (const line of lines) {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
      }
    }

    throw new Error("No JSON object found");
  }

  private captureWalletFile(homeDir: string): { privateKey: string; address?: string } | null {
    for (const candidate of this.walletFileCandidates(homeDir)) {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        privateKey?: string;
        address?: string;
      };

      if (typeof parsed.privateKey === "string") {
        return {
          privateKey: parsed.privateKey,
          address: typeof parsed.address === "string" ? parsed.address : undefined
        };
      }
    }

    return null;
  }

  private cleanupWalletArtifacts(homeDir: string) {
    for (const candidate of this.walletFileCandidates(homeDir)) {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { force: true });
      }
    }
  }

  private walletFileCandidates(homeDir: string): string[] {
    return [
      path.join(homeDir, "wallet.json"),
      path.join(homeDir, ".agentcash", "wallet.json")
    ];
  }

  private pickAddress(raw: unknown): string | undefined {
    return this.pickPreferredString(raw, ["address", "walletAddress", "wallet_address"]);
  }

  private pickNetwork(raw: unknown): string | undefined {
    return this.pickPreferredString(raw, ["network", "networkName", "chain"]);
  }

  private pickDepositLink(raw: unknown): string | undefined {
    return this.pickPreferredString(raw, ["depositLink", "deposit_link"]);
  }

  private pickTransactionHash(raw: unknown): string | undefined {
    return this.findStringByKey(raw, ["transactionHash", "transaction_hash", "txHash", "tx_hash"]);
  }

  private unwrapData(raw: unknown): unknown {
    const object = this.asObject(raw);
    if (object && "data" in object) {
      return object.data;
    }
    return raw;
  }

  private pickPreferredString(raw: unknown, keys: string[]): string | undefined {
    const loweredKeys = new Set(keys.map(key => key.toLowerCase()));
    const candidates = this.collectObjects(raw);
    const preferred = [
      ...candidates.filter(candidate => this.describeNetwork(candidate).includes("base")),
      ...candidates
    ];

    for (const candidate of preferred) {
      for (const [key, value] of Object.entries(candidate)) {
        if (!loweredKeys.has(key.toLowerCase())) {
          continue;
        }

        if (typeof value === "string" && value.trim()) {
          return value;
        }
      }
    }

    return undefined;
  }

  private extractPriceLikeValue(raw: unknown, keys: string[]): number | undefined {
    const loweredKeys = new Set(keys.map(key => key.toLowerCase()));

    for (const candidate of this.collectObjects(raw)) {
      for (const [key, value] of Object.entries(candidate)) {
        if (!loweredKeys.has(key.toLowerCase())) {
          continue;
        }

        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }

        if (typeof value === "string") {
          const normalized = value.replace(/[$,]/g, "").trim();
          const parsed = Number(normalized);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
    }

    return undefined;
  }

  private findStringByKey(raw: unknown, keys: string[]): string | undefined {
    const loweredKeys = new Set(keys.map(key => key.toLowerCase()));

    for (const candidate of this.collectObjects(raw)) {
      for (const [key, value] of Object.entries(candidate)) {
        if (loweredKeys.has(key.toLowerCase()) && typeof value === "string" && value.trim()) {
          return value;
        }
      }
    }

    return undefined;
  }

  private findArrayByKey(raw: unknown, keys: string[]): unknown[] | undefined {
    const loweredKeys = new Set(keys.map(key => key.toLowerCase()));

    for (const candidate of this.collectObjects(raw)) {
      for (const [key, value] of Object.entries(candidate)) {
        if (loweredKeys.has(key.toLowerCase()) && Array.isArray(value)) {
          return value;
        }
      }
    }

    return undefined;
  }

  private collectObjects(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
      return value.flatMap(item => this.collectObjects(item));
    }

    if (!value || typeof value !== "object") {
      return [];
    }

    const current = value as Record<string, unknown>;
    return [current, ...Object.values(current).flatMap(item => this.collectObjects(item))];
  }

  private describeNetwork(candidate: Record<string, unknown>): string {
    return [candidate.network, candidate.networkName, candidate.chain]
      .filter(value => typeof value === "string")
      .join(" ")
      .toLowerCase();
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }
}
