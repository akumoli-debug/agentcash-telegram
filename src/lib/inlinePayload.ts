import crypto from "node:crypto";
import { z } from "zod";
import type { SkillName } from "../agentcash/skillExecutor.js";
import type { AppDatabase } from "../db/client.js";
import { hashSensitiveValue } from "./crypto.js";
import { ValidationError } from "./errors.js";

export const INLINE_PAYLOAD_TTL_MS = 5 * 60 * 1000;

const inlinePayloadSchema = z.object({
  skill: z.enum(["research", "enrich", "generate"]),
  input: z.string().min(1).max(200),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(8).max(32)
});

export type InlinePayload = z.infer<typeof inlinePayloadSchema>;

export function createSignedInlinePayload(
  db: AppDatabase,
  masterKey: string,
  input: { skill: SkillName; sanitizedInput: string },
  nowMs = Date.now()
): { token: string; payload: InlinePayload } {
  const id = crypto.randomBytes(9).toString("base64url");
  const payload: InlinePayload = {
    skill: input.skill,
    input: input.sanitizedInput,
    timestamp: nowMs,
    nonce: crypto.randomBytes(9).toString("base64url")
  };
  const payloadJson = JSON.stringify(payload);
  const signature = signPayload(payloadJson, masterKey);
  const tokenSignature = signToken(id, signature, masterKey);
  const token = `il_${id}_${tokenSignature}`;

  db.createInlinePayload({
    id,
    tokenHash: hashInlineToken(token, masterKey),
    payloadJson,
    signature,
    expiresAt: new Date(nowMs + INLINE_PAYLOAD_TTL_MS).toISOString()
  });

  return { token, payload };
}

export function consumeSignedInlinePayload(
  db: AppDatabase,
  masterKey: string,
  token: string,
  nowMs = Date.now()
): InlinePayload {
  const parsedToken = parseInlineToken(token);
  const row = db.getInlinePayload(parsedToken.id);

  if (!row) {
    throw new ValidationError("This inline preview is no longer valid.");
  }

  const tokenHash = hashInlineToken(token, masterKey);
  if (!safeEqual(row.token_hash, tokenHash)) {
    throw new ValidationError("This inline preview is no longer valid.");
  }

  if (!safeEqual(parsedToken.tokenSignature, signToken(parsedToken.id, row.signature, masterKey))) {
    throw new ValidationError("This inline preview is no longer valid.");
  }

  if (!safeEqual(row.signature, signPayload(row.payload_json, masterKey))) {
    throw new ValidationError("This inline preview was modified and cannot be used.");
  }

  const payload = inlinePayloadSchema.parse(JSON.parse(row.payload_json));
  if (nowMs - payload.timestamp > INLINE_PAYLOAD_TTL_MS || new Date(row.expires_at).getTime() <= nowMs) {
    throw new ValidationError("This inline preview has expired. Try the inline query again.");
  }

  const consumed = db.consumeInlinePayload(parsedToken.id, tokenHash, new Date(nowMs).toISOString());
  if (!consumed) {
    throw new ValidationError("This inline preview was already used or has expired.");
  }

  return payload;
}

export function isInlineStartPayload(input: string): boolean {
  return input.startsWith("il_");
}

function parseInlineToken(token: string): { id: string; tokenSignature: string } {
  const match = /^il_([A-Za-z0-9_-]{12})_([a-f0-9]{16})$/.exec(token);
  if (!match) {
    throw new ValidationError("This inline preview is no longer valid.");
  }

  return { id: match[1]!, tokenSignature: match[2]! };
}

function signPayload(payloadJson: string, masterKey: string): string {
  return hashSensitiveValue(`inline-payload:${payloadJson}`, masterKey);
}

function signToken(id: string, payloadSignature: string, masterKey: string): string {
  return hashSensitiveValue(`inline-token:${id}:${payloadSignature}`, masterKey).slice(0, 16);
}

function hashInlineToken(token: string, masterKey: string): string {
  return hashSensitiveValue(`inline-start-token:${token}`, masterKey);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
