import crypto from "node:crypto";
import type { AppDatabase } from "../db/client.js";

export interface PairingCodeInput {
  id: string;
  platform: string;
  actorIdHash: string;
  codeHash: string;
  expiresAt: string;
}

export function generatePairingCode(): { code: string; codeHash: string } {
  // 8 hex chars = 4 random bytes → 16^8 = 4 billion combinations, enough for OTP use.
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  return { code, codeHash };
}

export function issuePairingCode(
  db: AppDatabase,
  platform: string,
  actorIdHash: string,
  ttlSeconds: number
): { code: string; expiresAt: string } {
  const { code, codeHash } = generatePairingCode();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  db.expireActorPairingCodes(platform, actorIdHash);
  db.createPairingCode({ id: crypto.randomUUID(), platform, actorIdHash, codeHash, expiresAt });

  return { code, expiresAt };
}
