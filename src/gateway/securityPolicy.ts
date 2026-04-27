// Gateway security policy: evaluated before any command executes.
// All IDs arriving here must already be hashed — raw IDs are never accepted.

export type Platform = "telegram" | "discord";
export type ChatType = "private" | "group" | "guild" | "channel";
export type WalletScope = "user" | "group" | "guild" | "none";

export type PolicyResult =
  | "allow"
  | "deny_silent"
  | "deny_with_dm_instruction"
  | "deny_with_allowlist_message"
  | "require_pairing";

export interface PolicyDecision {
  result: PolicyResult;
}

export interface PolicyInput {
  platform: Platform;
  actorIdHash: string;
  chatIdHash: string;
  chatType: ChatType;
  isCommand: boolean;
  commandName?: string;
  botWasMentioned: boolean;
  messageAuthorIsBot: boolean;
  walletScopeRequested: WalletScope;
  isCallbackQuery?: boolean;
}

export interface SecurityPolicyConfig {
  allowAllUsers: boolean;
  allowedActorHashes: Set<string>;
  pairingMode: "disabled" | "dm_code";
  telegramGroupRequireMention: boolean;
  discordGuildRequireMention: boolean;
  freeResponseChatIdHashes: Set<string>;
}

// Telegram private-wallet commands: must only execute in a private chat.
export const PRIVATE_WALLET_COMMANDS_TELEGRAM = new Set([
  "start",
  "deposit",
  "balance",
  "cap",
  "history",
  "research",
  "enrich",
  "generate",
]);

export function evaluatePolicy(
  input: PolicyInput,
  config: SecurityPolicyConfig
): PolicyDecision {
  // 1. Always ignore bot-authored messages (self-messages, system messages).
  if (input.messageAuthorIsBot) {
    return { result: "deny_silent" };
  }

  // 2. Approval/cancel callbacks always pass; they are verified at the handler level.
  if (input.isCallbackQuery) {
    return { result: "allow" };
  }

  const isGroupChat =
    input.chatType === "group" ||
    input.chatType === "guild" ||
    input.chatType === "channel";

  // 3. Allowlist / pairing gate.
  if (!config.allowAllUsers && !config.allowedActorHashes.has(input.actorIdHash)) {
    if (config.pairingMode === "dm_code") {
      // Pairing codes must only be issued in private/DM — never in groups.
      if (isGroupChat) {
        return { result: "deny_silent" };
      }
      return { result: "require_pairing" };
    }
    return { result: "deny_with_allowlist_message" };
  }

  // 4. Private-wallet command guard: must only run in private/DM.
  if (isGroupChat) {
    if (
      input.platform === "telegram" &&
      input.commandName &&
      PRIVATE_WALLET_COMMANDS_TELEGRAM.has(input.commandName)
    ) {
      return { result: "deny_with_dm_instruction" };
    }
    // Discord /ac wallet subcommands are inherently ephemeral via slash command
    // restrictions in buildDiscordCommandPayload; group enforcement is handled there.
  }

  // 5. Group require-mention gate (natural language only — slash commands always pass).
  if (isGroupChat && !input.isCommand) {
    const requireMention =
      (input.platform === "telegram" && config.telegramGroupRequireMention) ||
      (input.platform === "discord" && config.discordGuildRequireMention);

    if (requireMention) {
      const chatBypassed = config.freeResponseChatIdHashes.has(input.chatIdHash);
      if (!chatBypassed && !input.botWasMentioned) {
        return { result: "deny_silent" };
      }
    }
  }

  return { result: "allow" };
}
