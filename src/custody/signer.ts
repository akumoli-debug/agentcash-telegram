import type { AppConfig } from "../config.js";
import type { WalletRow } from "../db/client.js";
import { ConfigError } from "../lib/errors.js";
import { KmsSigner } from "./kmsSigner.js";
import { LocalCliSigner } from "./localCliSigner.js";
import { LocalEncryptedSigner } from "./localEncryptedSigner.js";
import { RemoteSignerClient } from "./remoteSignerClient.js";

export type CustodyMode = "local_cli" | "local_encrypted" | "remote_signer" | "kms";

export interface WalletRef {
  walletId: string;
  walletRef: string;
  signerBackend: CustodyMode;
}

export interface SignPaymentRequestInput {
  walletRef: WalletRef;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

export interface SignedPayment {
  walletRef: WalletRef;
  signedRequest: unknown;
  signerBackend: CustodyMode;
}

export interface RotationResult {
  walletRef: WalletRef;
  previousKeyVersion: number | null;
  activeKeyVersion: number;
  publicAddress?: string;
  migrationRequired: boolean;
}

export interface HealthStatus {
  ok: boolean;
  mode: CustodyMode;
  message?: string;
}

export interface Signer {
  getAddress(walletRef: WalletRef): Promise<string>;
  signPaymentRequest(input: SignPaymentRequestInput): Promise<SignedPayment>;
  rotateKey?(walletRef: WalletRef): Promise<RotationResult>;
  healthCheck(): Promise<HealthStatus>;
}

export function createSigner(config: AppConfig): Signer {
  switch (config.CUSTODY_MODE) {
    case "local_cli":
      return new LocalCliSigner(config);
    case "local_encrypted":
      return new LocalEncryptedSigner(config);
    case "remote_signer":
      return new RemoteSignerClient(config);
    case "kms":
      return new KmsSigner(config);
    default:
      throw new ConfigError(`Unsupported custody mode: ${String(config.CUSTODY_MODE)}`);
  }
}

export function walletRefForRow(wallet: WalletRow): WalletRef {
  return {
    walletId: wallet.id,
    walletRef: wallet.wallet_ref ?? wallet.home_dir_hash ?? wallet.id,
    signerBackend: (wallet.signer_backend ?? "local_cli") as CustodyMode
  };
}
