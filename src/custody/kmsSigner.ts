import type { AppConfig } from "../config.js";
import { ConfigError } from "../lib/errors.js";
import type {
  HealthStatus,
  SignedPayment,
  SignPaymentRequestInput,
  Signer,
  WalletRef
} from "./signer.js";

export class KmsSigner implements Signer {
  readonly mode = "kms" as const;

  constructor(private readonly config: AppConfig) {}

  async healthCheck(): Promise<HealthStatus> {
    void this.config;
    throw new ConfigError("CUSTODY_MODE=kms is reserved for a future reviewed KMS/HSM signer and is not implemented yet");
  }

  async getAddress(_walletRef: WalletRef): Promise<string> {
    throw new ConfigError("CUSTODY_MODE=kms cannot return addresses until the KMS signer is implemented");
  }

  async signPaymentRequest(_input: SignPaymentRequestInput): Promise<SignedPayment> {
    throw new ConfigError("CUSTODY_MODE=kms cannot sign payments until the KMS signer is implemented");
  }
}
