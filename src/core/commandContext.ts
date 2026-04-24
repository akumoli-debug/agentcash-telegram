import type { SkillName } from "../agentcash/skillExecutor.js";

export type PlatformName = "telegram" | "discord";

export interface WalletScope {
  kind: "user" | "guild";
  walletOwnerId: string;
  chatId: string;
  chatType?: string;
  guildId?: string | null;
  channelId?: string | null;
}

export interface CommandContext {
  platform: PlatformName;
  actorIdHash: string;
  chatIdHash?: string;
  guildIdHash?: string;
  channelIdHash?: string;
  walletScope: WalletScope;
  actorProfile?: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  messageId?: string | null;
  reply(message: string): Promise<void>;
  replyPrivateOrEphemeral(message: string): Promise<void>;
  confirm(input: {
    text: string;
    quoteId: string;
    skill: SkillName;
  }): Promise<void>;
}
