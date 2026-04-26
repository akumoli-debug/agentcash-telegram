import type { AppConfig } from "../config.js";
import { ConfigError } from "../lib/errors.js";
import type {
  HealthStatus,
  SignedPayment,
  SignPaymentRequestInput,
  Signer,
  WalletRef
} from "./signer.js";

export class LocalEncryptedSigner implements Signer {
  readonly mode = "local_encrypted" as const;

  constructor(private readonly config: AppConfig) {}

  async healthCheck(): Promise<HealthStatus> {
    return {
      ok: true,
      mode: this.mode,
      message: "Local encrypted custody is demo-only and keeps decrypted keys inside the custody module."
    };
  }

  async getAddress(walletRef: WalletRef): Promise<string> {
    if (!walletRef.walletRef) {
      throw new ConfigError("Local encrypted wallet is missing a wallet reference");
    }
    return walletRef.walletRef;
  }

  async signPaymentRequest(input: SignPaymentRequestInput): Promise<SignedPayment> {
    void this.config;
    return {
      walletRef: input.walletRef,
      signerBackend: this.mode,
      signedRequest: {
        mode: "local_encrypted_stub",
        note: "Direct local signing is not wired to a production-reviewed signer."
      }
    };
  }
}
