import type { AppConfig } from "../config.js";
import { ConfigError } from "../lib/errors.js";
import type {
  HealthStatus,
  SignedPayment,
  SignPaymentRequestInput,
  Signer,
  WalletRef
} from "./signer.js";

export class RemoteSignerClient implements Signer {
  readonly mode = "remote_signer" as const;

  constructor(private readonly config: AppConfig) {}

  async healthCheck(): Promise<HealthStatus> {
    if (!this.config.REMOTE_SIGNER_URL) {
      throw new ConfigError("REMOTE_SIGNER_URL is required when CUSTODY_MODE=remote_signer");
    }

    const response = await fetch(new URL("/healthz", this.config.REMOTE_SIGNER_URL));
    if (!response.ok) {
      throw new ConfigError(`Remote signer health check failed with HTTP ${response.status}`);
    }

    return { ok: true, mode: this.mode };
  }

  async getAddress(walletRef: WalletRef): Promise<string> {
    if (!this.config.REMOTE_SIGNER_URL) {
      throw new ConfigError("REMOTE_SIGNER_URL is required when CUSTODY_MODE=remote_signer");
    }

    const response = await fetch(new URL(`/wallets/${encodeURIComponent(walletRef.walletRef)}/address`, this.config.REMOTE_SIGNER_URL));
    if (!response.ok) {
      throw new ConfigError(`Remote signer address lookup failed with HTTP ${response.status}`);
    }

    const body = await response.json() as { address?: unknown };
    if (typeof body.address !== "string" || !body.address) {
      throw new ConfigError("Remote signer did not return a wallet address");
    }

    return body.address;
  }

  async signPaymentRequest(input: SignPaymentRequestInput): Promise<SignedPayment> {
    if (!this.config.REMOTE_SIGNER_URL) {
      throw new ConfigError("REMOTE_SIGNER_URL is required when CUSTODY_MODE=remote_signer");
    }

    const response = await fetch(new URL("/sign-payment-request", this.config.REMOTE_SIGNER_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      throw new ConfigError(`Remote signer payment signing failed with HTTP ${response.status}`);
    }

    return {
      walletRef: input.walletRef,
      signerBackend: this.mode,
      signedRequest: await response.json()
    };
  }
}
