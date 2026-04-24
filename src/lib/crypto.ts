import crypto from "node:crypto";

export function decodeMasterKey(masterKey: string): Buffer {
  return Buffer.from(masterKey, "base64");
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = decodeMasterKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string, masterKey: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = payload.split(".");

  if (version !== "v1" || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Unsupported encrypted payload format");
  }

  const key = decodeMasterKey(masterKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final()
  ]);

  return plaintext.toString("utf8");
}

export function hashSensitiveValue(input: string, masterKey: string): string {
  return crypto
    .createHmac("sha256", decodeMasterKey(masterKey))
    .update(input)
    .digest("hex");
}

export function hashTelegramId(telegramId: string, masterKey: string): string {
  return hashSensitiveValue(telegramId, masterKey).slice(0, 24);
}
