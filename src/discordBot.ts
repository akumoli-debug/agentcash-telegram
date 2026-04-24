import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import type { SkillExecutor } from "./agentcash/skillExecutor.js";
import type { AppConfig } from "./config.js";
import type { CommandContext } from "./core/commandContext.js";
import { runBalanceCommand, runDepositCommand, runSkillCommand } from "./core/commandHandlers.js";
import type { AppDatabase } from "./db/client.js";
import { hashSensitiveValue } from "./lib/crypto.js";
import { QuoteError } from "./lib/errors.js";
import type { AppLogger } from "./lib/logger.js";
import type { WalletManager } from "./wallets/walletManager.js";

const CONFIRM_PREFIX = "discord_confirm:";
const CANCEL_PREFIX = "discord_cancel:";

export interface DiscordDeps {
  config: AppConfig;
  logger: AppLogger;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
}

export function createDiscordBot(deps: DiscordDeps): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  client.once(Events.ClientReady, readyClient => {
    deps.logger.info({ userIdHash: hashDiscordId(readyClient.user.id, deps.config) }, "discord bot ready");
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "ac") {
        await handleSlashCommand(interaction, deps);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction, deps);
      }
    } catch (error) {
      deps.logger.warn(
        {
          err: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
          actorIdHash: hashDiscordId(interaction.user.id, deps.config),
          guildIdHash: interaction.guildId ? hashDiscordId(interaction.guildId, deps.config) : undefined,
          channelIdHash: interaction.channelId ? hashDiscordId(interaction.channelId, deps.config) : undefined
        },
        "discord interaction failed"
      );

      await replyToInteraction(interaction, safeDiscordError(error), true);
    }
  });

  return client;
}

export async function registerDiscordCommands(config: AppConfig): Promise<void> {
  if (!config.DISCORD_BOT_TOKEN || !config.DISCORD_APPLICATION_ID) {
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("ac")
      .setDescription("AgentCash wallet and paid calls")
      .addSubcommand(sub => sub.setName("balance").setDescription("Show your AgentCash wallet balance"))
      .addSubcommand(sub => sub.setName("deposit").setDescription("Show your AgentCash deposit address"))
      .addSubcommand(sub =>
        sub
          .setName("research")
          .setDescription("Estimate and run a research call after confirmation when needed")
          .addStringOption(option =>
            option.setName("query").setDescription("Research query").setRequired(true).setMaxLength(300)
          )
      )
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(config.DISCORD_APPLICATION_ID), { body: commands });
}

export function createDiscordCommandContext(
  interaction: ChatInputCommandInteraction,
  config: AppConfig
): CommandContext {
  const userWalletOwnerId = `discord:${interaction.user.id}`;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const chatId = guildId ? `discord:guild:${guildId}:channel:${channelId}` : `discord:dm:${interaction.user.id}`;

  return {
    platform: "discord",
    actorIdHash: hashDiscordId(interaction.user.id, config),
    guildIdHash: guildId ? hashDiscordId(guildId, config) : undefined,
    channelIdHash: channelId ? hashDiscordId(channelId, config) : undefined,
    chatIdHash: hashDiscordId(chatId, config),
    walletScope: guildId
      ? {
          kind: "guild",
          walletOwnerId: `discord:guild:${guildId}`,
          chatId,
          chatType: "guild",
          guildId,
          channelId
        }
      : {
          kind: "user",
          walletOwnerId: userWalletOwnerId,
          chatId,
          chatType: "private",
          channelId
        },
    messageId: interaction.id,
    reply: async message => {
      await replyToInteraction(interaction, message, false);
    },
    replyPrivateOrEphemeral: async message => {
      await replyToInteraction(interaction, message, true);
    },
    confirm: async input => {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CONFIRM_PREFIX}${input.quoteId}`)
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${CANCEL_PREFIX}${input.quoteId}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ content: input.text, components: [row], ephemeral: true });
    }
  };
}

function createDiscordButtonContext(interaction: Interaction): {
  walletOwnerId: string;
  chatId: string;
} {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  return {
    walletOwnerId: `discord:${interaction.user.id}`,
    chatId: guildId ? `discord:guild:${guildId}:channel:${channelId}` : `discord:dm:${interaction.user.id}`
  };
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction, deps: DiscordDeps): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const ctx = createDiscordCommandContext(interaction, deps.config);

  deps.logger.info(
    {
      subcommand,
      actorIdHash: ctx.actorIdHash,
      guildIdHash: ctx.guildIdHash,
      channelIdHash: ctx.channelIdHash
    },
    "incoming Discord slash command"
  );

  if (subcommand === "balance") {
    await runBalanceCommand(ctx, deps);
    return;
  }

  if (subcommand === "deposit") {
    await runDepositCommand(ctx, deps);
    return;
  }

  if (subcommand === "research") {
    const query = interaction.options.getString("query", true);
    await runSkillCommand(ctx, deps, "research", query);
    return;
  }

  await replyToInteraction(interaction, "Unknown AgentCash command.", true);
}

async function handleButton(interaction: Interaction, deps: DiscordDeps): Promise<void> {
  if (!interaction.isButton()) {
    return;
  }

  const data = interaction.customId;
  const isConfirm = data.startsWith(CONFIRM_PREFIX);
  const isCancel = data.startsWith(CANCEL_PREFIX);
  if (!isConfirm && !isCancel) {
    return;
  }

  const quoteId = data.slice((isConfirm ? CONFIRM_PREFIX : CANCEL_PREFIX).length);
  const buttonContext = createDiscordButtonContext(interaction);
  const user = deps.walletManager.getExistingUser(buttonContext.walletOwnerId);
  const quote = deps.db.getQuote(quoteId);
  const sessionUserId = quote?.requester_user_id ?? user.id;
  const session = deps.db.getSession(sessionUserId, buttonContext.chatId);
  const sessionState = parseQuoteSessionState(session?.state_json ?? null);

  if (!sessionState || sessionState.quote_id !== quoteId) {
    await interaction.reply({ content: "This confirmation is no longer valid.", ephemeral: true });
    return;
  }

  if (isCancel) {
    const consumed = deps.db.consumeSessionState(sessionUserId, buttonContext.chatId, session?.state_json ?? "");
    if (!consumed) {
      await interaction.reply({ content: "This confirmation was already used.", ephemeral: true });
      return;
    }

    deps.db.updateQuoteStatus(quoteId, "cancelled");
    await interaction.reply({ content: "Pending call cancelled.", ephemeral: true });
    return;
  }

  try {
    const result = await deps.skillExecutor.executeApprovedQuote(quoteId, {
      telegramId: buttonContext.walletOwnerId,
      telegramChatId: buttonContext.chatId,
      telegramChatType: "private",
      telegramMessageId: interaction.id
    });

    deps.db.consumeSessionState(sessionUserId, buttonContext.chatId, session?.state_json ?? "");
    await interaction.reply({ content: result.text, ephemeral: true });
  } catch (error) {
    if (error instanceof QuoteError) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }
    throw error;
  }
}

async function replyToInteraction(
  interaction: Interaction,
  content: string,
  ephemeral: boolean
): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral });
    return;
  }

  await interaction.reply({ content, ephemeral });
}

function parseQuoteSessionState(stateJson: string | null): { type: string; quote_id: string } | null {
  if (!stateJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(stateJson) as { type?: unknown; quote_id?: unknown };
    if (parsed.type === "quote_confirmation" && typeof parsed.quote_id === "string") {
      return { type: parsed.type, quote_id: parsed.quote_id };
    }
  } catch {
    return null;
  }

  return null;
}

function safeDiscordError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong while handling that Discord command.";
}

function hashDiscordId(value: string, config: AppConfig): string {
  return hashSensitiveValue(`discord:${value}`, config.MASTER_ENCRYPTION_KEY).slice(0, 24);
}
