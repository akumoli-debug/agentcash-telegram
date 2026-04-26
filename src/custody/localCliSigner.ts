import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import type { WalletRow } from "../db/client.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { ConfigError, AgentCashError } from "../lib/errors.js";
import type {
  HealthStatus,
  RotationResult,
  SignedPayment,
  SignPaymentRequestInput,
  Signer,
  WalletRef
} from "./signer.js";

const execFileAsync = promisify(execFile);

export type LocalCliHealthRunner = () => Promise<void>;

export interface CapturedLocalWallet {
  address?: string;
  encryptedPrivateKey?: string;
}

export class LocalCliSigner implements Signer {
  readonly mode = "local_cli" as const;

  constructor(
    private readonly config: AppConfig,
    private readonly healthRunner?: LocalCliHealthRunner
  ) {}

  async healthCheck(): Promise<HealthStatus> {
    if (this.healthRunner) {
      await this.healthRunner();
      return { ok: true, mode: this.mode };
    }

    try {
      await execFileAsync(this.config.AGENTCASH_COMMAND, ["--version"], {
        timeout: 10_000,
        env: { ...process.env }
      });
    } catch {
      throw new ConfigError(
        `AgentCash CLI not found or not executable: ${this.config.AGENTCASH_COMMAND}. ` +
        "Set AGENTCASH_COMMAND and ensure the CLI is installed."
      );
    }

    const homeRoot = path.resolve(this.config.AGENTCASH_HOME_ROOT);
    fs.mkdirSync(homeRoot, { recursive: true });

    const testFile = path.join(homeRoot, ".write-test");
    try {
      fs.writeFileSync(testFile, "ok");
      fs.rmSync(testFile, { force: true });
    } catch {
      throw new ConfigError(
        `AgentCash home root is not writable: ${homeRoot}. ` +
        "Check AGENTCASH_HOME_ROOT and directory permissions."
      );
    }

    return { ok: true, mode: this.mode };
  }

  async getAddress(walletRef: WalletRef): Promise<string> {
    if (!walletRef.walletRef) {
      throw new AgentCashError("Local CLI wallet is missing a wallet reference");
    }
    return walletRef.walletRef;
  }

  async signPaymentRequest(input: SignPaymentRequestInput): Promise<SignedPayment> {
    return {
      walletRef: input.walletRef,
      signerBackend: this.mode,
      signedRequest: {
        mode: "local_cli_delegated",
        note: "Local CLI signing is performed inside the AgentCash CLI subprocess."
      }
    };
  }

  async rotateKey(walletRef: WalletRef): Promise<RotationResult> {
    throw new ConfigError(
      `Automatic key rotation is not implemented for ${walletRef.signerBackend}. ` +
      "Create a new demo wallet, move funds manually, and deprecate the old key after migration."
    );
  }

  buildCommandEnv(wallet: WalletRow, homeDir: string): NodeJS.ProcessEnv {
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

  captureWallet(homeDir: string, wallet: WalletRow): CapturedLocalWallet {
    const captured = this.captureWalletFile(homeDir);
    const encryptedPrivateKey =
      wallet.encrypted_private_key ??
      (captured?.privateKey
        ? encryptSecret(captured.privateKey, this.config.MASTER_ENCRYPTION_KEY)
        : undefined);

    this.cleanupWalletArtifacts(homeDir);

    return {
      address: captured?.address,
      encryptedPrivateKey
    };
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
}
