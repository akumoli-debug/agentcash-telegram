import { hashSensitiveValue, hashTelegramId } from "../lib/crypto.js";
import type { AppConfig } from "../config.js";
import type { SecurityPolicyConfig } from "./securityPolicy.js";

// Builds the runtime SecurityPolicyConfig from the application config.
// Raw user IDs from env vars are hashed here using the master key so that
// no raw IDs ever appear in logs or in memory beyond this function.
export function buildSecurityPolicyConfig(config: AppConfig): SecurityPolicyConfig {
  const masterKey = config.MASTER_ENCRYPTION_KEY;
  const allowedActorHashes = new Set<string>();

  // TELEGRAM_ALLOWED_USERS: comma-separated raw Telegram numeric user IDs.
  if (config.TELEGRAM_ALLOWED_USERS) {
    for (const rawId of splitIds(config.TELEGRAM_ALLOWED_USERS)) {
      allowedActorHashes.add(hashTelegramId(rawId, masterKey));
    }
  }

  // DISCORD_ALLOWED_USERS: comma-separated raw Discord user IDs.
  if (config.DISCORD_ALLOWED_USERS) {
    for (const rawId of splitIds(config.DISCORD_ALLOWED_USERS)) {
      allowedActorHashes.add(
        hashSensitiveValue(`discord:${rawId}`, masterKey).slice(0, 24)
      );
    }
  }

  // GATEWAY_ALLOWED_USERS: platform-prefixed IDs ("tg:123" or "dc:123").
  if (config.GATEWAY_ALLOWED_USERS) {
    for (const entry of splitIds(config.GATEWAY_ALLOWED_USERS)) {
      if (entry.startsWith("tg:")) {
        allowedActorHashes.add(hashTelegramId(entry.slice(3), masterKey));
      } else if (entry.startsWith("dc:")) {
        allowedActorHashes.add(
          hashSensitiveValue(`discord:${entry.slice(3)}`, masterKey).slice(0, 24)
        );
      }
      // Unknown prefix: ignored (operator error; log handled at startup if desired).
    }
  }

  const freeResponseChatIdHashes = new Set<string>();
  if (config.GROUP_FREE_RESPONSE_CHAT_IDS) {
    for (const chatId of splitIds(config.GROUP_FREE_RESPONSE_CHAT_IDS)) {
      // These are stored as hashed chat IDs (already computed by callers using
      // hashSensitiveValue(`chat:${rawChatId}`, masterKey).slice(0, 24)).
      freeResponseChatIdHashes.add(chatId.trim());
    }
  }

  return {
    allowAllUsers: config.GATEWAY_ALLOW_ALL_USERS,
    allowedActorHashes,
    pairingMode: config.PAIRING_MODE,
    telegramGroupRequireMention: config.TELEGRAM_GROUP_REQUIRE_MENTION,
    discordGuildRequireMention: config.DISCORD_GUILD_REQUIRE_MENTION,
    freeResponseChatIdHashes
  };
}

function splitIds(raw: string): string[] {
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
