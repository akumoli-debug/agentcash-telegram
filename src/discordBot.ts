import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import type { SkillExecutor } from "./agentcash/skillExecutor.js";
import type { AppConfig } from "./config.js";
import type { CommandContext } from "./core/commandContext.js";
import {
  runBalanceCommand,
  runCapCommand,
  runDepositCommand,
  runHistoryCommand,
  runSkillCommand
} from "./core/commandHandlers.js";
import type { AppDatabase } from "./db/client.js";
import { hashSensitiveValue } from "./lib/crypto.js";
import { QuoteError, ValidationError } from "./lib/errors.js";
import type { AppLogger } from "./lib/logger.js";
import { WalletManager } from "./wallets/walletManager.js";
import { evaluatePolicy, type SecurityPolicyConfig } from "./gateway/securityPolicy.js";

const CONFIRM_PREFIX = "discord_confirm:";
const CANCEL_PREFIX = "discord_cancel:";

export interface DiscordDeps {
  config: AppConfig;
  logger: AppLogger;
  db: AppDatabase;
  walletManager: WalletManager;
  skillExecutor: SkillExecutor;
}

export function createDiscordBot(deps: DiscordDeps & { securityPolicy: SecurityPolicyConfig }): Client {
  const { securityPolicy } = deps;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  client.once(Events.ClientReady, readyClient => {
    deps.logger.info({ userIdHash: hashDiscordId(readyClient.user.id, deps.config) }, "discord bot ready");
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      // Always ignore bot-authored interactions (bots cannot send slash commands,
      // but guard defensively).
      if (interaction.user.bot) {
        return;
      }

      // Evaluate gateway security policy before any command handling.
      const actorIdHash = hashDiscordId(interaction.user.id, deps.config);
      const channelId = interaction.channelId ?? interaction.user.id;
      const chatIdHash = hashDiscordId(channelId, deps.config);
      const isGuild = Boolean(interaction.guildId);
      const chatType = isGuild ? "guild" as const : "private" as const;

      const decision = evaluatePolicy(
        {
          platform: "discord",
          actorIdHash,
          chatIdHash,
          chatType,
          isCommand: true,
          commandName: interaction.isChatInputCommand() ? interaction.options.getSubcommandGroup(false) ?? interaction.options.getSubcommand(false) ?? undefined : undefined,
          botWasMentioned: false,
          messageAuthorIsBot: interaction.user.bot ?? false,
          walletScopeRequested: isGuild ? "guild" : "user",
          isCallbackQuery: interaction.isButton()
        },
        securityPolicy
      );

      if (decision.result === "deny_silent") {
        return;
      }
      if (decision.result === "deny_with_dm_instruction") {
        await replyToInteraction(interaction, "Use DM commands for private wallet operations.", true);
        return;
      }
      if (decision.result === "deny_with_allowlist_message") {
        await replyToInteraction(interaction, "This bot is restricted to approved users. Contact the operator to request access.", true);
        return;
      }
      if (decision.result === "require_pairing") {
        await replyToInteraction(interaction, "You need to pair your account first. DM the bot to get a pairing code.", true);
        return;
      }

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

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
  const route = config.DISCORD_DEV_GUILD_ID
    ? Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_DEV_GUILD_ID)
    : Routes.applicationCommands(config.DISCORD_APPLICATION_ID);

  await rest.put(route, { body: buildDiscordCommandPayload() });
}

export function buildDiscordCommandPayload(): unknown[] {
  const command = new SlashCommandBuilder()
      .setName("ac")
      .setDescription("AgentCash wallet and paid calls")
      .addSubcommandGroup(group =>
        group
          .setName("wallet")
          .setDescription("Private Discord user wallet")
          .addSubcommand(sub => sub.setName("balance").setDescription("Show your user wallet balance"))
          .addSubcommand(sub => sub.setName("deposit").setDescription("Show your user wallet deposit address"))
          .addSubcommand(sub => sub.setName("freeze").setDescription("Freeze your user wallet"))
          .addSubcommand(sub => sub.setName("unfreeze").setDescription("Unfreeze your user wallet"))
          .addSubcommand(sub => sub.setName("status").setDescription("Show your user wallet status"))
          .addSubcommand(sub =>
            sub
              .setName("cap")
              .setDescription("Show or set your user wallet cap")
              .addStringOption(option =>
                option.setName("amount").setDescription("Amount, show, or off").setRequired(false).setMaxLength(32)
              )
          )
          .addSubcommand(sub => sub.setName("history").setDescription("Show your private wallet history"))
          .addSubcommand(sub => sub.setName("policy").setDescription("Show your user wallet spend policy"))
          .addSubcommand(sub =>
            sub
              .setName("research")
              .setDescription("Quote and run research using your user wallet")
              .addStringOption(option =>
                option.setName("query").setDescription("Research query").setRequired(true).setMaxLength(300)
              )
          )
      )
      .addSubcommandGroup(group =>
        group
          .setName("guild")
          .setDescription("Experimental Discord guild wallet")
          .addSubcommand(sub => sub.setName("create").setDescription("Create or show the guild wallet"))
          .addSubcommand(sub => sub.setName("balance").setDescription("Show the guild wallet balance"))
          .addSubcommand(sub => sub.setName("freeze").setDescription("Freeze the guild wallet"))
          .addSubcommand(sub => sub.setName("unfreeze").setDescription("Unfreeze the guild wallet"))
          .addSubcommand(sub => sub.setName("status").setDescription("Show the guild wallet status"))
          .addSubcommand(sub =>
            sub
              .setName("deposit")
              .setDescription("Show the guild wallet deposit address")
              .addBooleanOption(option =>
                option.setName("public").setDescription("Post deposit details publicly").setRequired(false)
              )
          )
          .addSubcommand(sub =>
            sub
              .setName("cap")
              .setDescription("Show or set the guild wallet cap")
              .addStringOption(option =>
                option.setName("amount").setDescription("Amount, show, or off").setRequired(false).setMaxLength(32)
              )
          )
          .addSubcommand(sub => sub.setName("history").setDescription("Show guild wallet history"))
          .addSubcommand(sub => sub.setName("policy").setDescription("Show guild wallet spend policy"))
          .addSubcommand(sub => sub.setName("sync-admins").setDescription("Sync Discord managers to guild wallet admins"))
          .addSubcommand(sub =>
            sub
              .setName("research")
              .setDescription("Quote and run research using the guild wallet")
              .addStringOption(option =>
                option.setName("query").setDescription("Research query").setRequired(true).setMaxLength(300)
              )
          )
      )
      .toJSON() as unknown as Record<string, unknown>;

  command.integration_types = [0];
  command.contexts = [0, 1, 2];

  return [command];
}

export function createDiscordCommandContext(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  scope: "wallet" | "guild" = "wallet"
): CommandContext {
  const userWalletOwnerId = `discord:${interaction.user.id}`;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const chatId =
    scope === "guild" && guildId
      ? guildId
      : guildId
      ? `discord:user:${interaction.user.id}:channel:${channelId}`
      : `discord:dm:${interaction.user.id}`;

  return {
    platform: "discord",
    actorIdHash: hashDiscordId(interaction.user.id, config),
    guildIdHash: guildId ? hashDiscordId(guildId, config) : undefined,
    channelIdHash: channelId ? hashDiscordId(channelId, config) : undefined,
    chatIdHash: hashDiscordId(chatId, config),
    walletScope: scope === "guild" && guildId
      ? {
          kind: "guild",
          walletOwnerId: userWalletOwnerId,
          chatId,
          chatType: "discord_guild",
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

function assertDiscordGuildAdmin(interaction: ChatInputCommandInteraction | Interaction): void {
  if (!interaction.guildId || !interaction.member) {
    throw new ValidationError("Guild wallet admin actions must be run inside a Discord server.");
  }

  if (!hasDiscordGuildAdminPermission(interaction.member)) {
    throw new ValidationError("Only Discord members with Manage Server or Administrator can manage a guild wallet.");
  }
}

function hasDiscordGuildAdminPermission(member: unknown): boolean {
  const permissions = (member as { permissions?: unknown }).permissions;
  if (!permissions) {
    return false;
  }

  if (typeof permissions === "string") {
    const bitfield = new PermissionsBitField(BigInt(permissions));
    return bitfield.has(PermissionsBitField.Flags.ManageGuild) || bitfield.has(PermissionsBitField.Flags.Administrator);
  }

  if (typeof (permissions as { has?: unknown }).has === "function") {
    const permissionSet = permissions as { has(permission: bigint): boolean };
    return permissionSet.has(PermissionsBitField.Flags.ManageGuild) || permissionSet.has(PermissionsBitField.Flags.Administrator);
  }

  return false;
}

async function syncDiscordGuildAdmins(
  interaction: ChatInputCommandInteraction,
  deps: DiscordDeps,
  groupId: string
): Promise<{ promoted: number; demoted: number }> {
  const guildMembers = await interaction.guild?.members.fetch();
  if (!guildMembers) {
    throw new ValidationError("Could not fetch Discord guild members for admin sync.");
  }

  const adminDiscordIds = new Set<string>();
  let promoted = 0;
  let demoted = 0;

  for (const member of guildMembers.values()) {
    if (!hasDiscordGuildAdminPermission(member)) {
      continue;
    }

    adminDiscordIds.add(member.user.id);
    const user = deps.db.getUserByTelegramId(`discord:${member.user.id}`);
    if (!user) {
      continue;
    }

    const result = deps.db.updateGroupMemberRole(groupId, user.id, "admin");
    if (result.changed && result.previousRole !== "owner") {
      promoted += 1;
      deps.db.createAuditEvent({
        eventName: "group_admin.promoted",
        groupId,
        actorHash: user.id,
        status: "admin",
        metadata: { source: "discord_sync" }
      });
    }
  }

  for (const member of deps.db.getGroupMembers(groupId)) {
    if (member.role !== "admin") {
      continue;
    }

    const user = deps.db.getUserById(member.user_id);
    if (!user?.telegram_user_id.startsWith("discord:")) {
      continue;
    }

    const discordId = user.telegram_user_id.slice("discord:".length);
    if (adminDiscordIds.has(discordId)) {
      continue;
    }

    const result = deps.db.updateGroupMemberRole(groupId, member.user_id, "member");
    if (result.changed) {
      demoted += 1;
      deps.db.createAuditEvent({
        eventName: "group_admin.demoted",
        groupId,
        actorHash: member.user_id,
        status: "member",
        metadata: { source: "discord_sync" }
      });
    }
  }

  return { promoted, demoted };
}

export async function handleSlashCommand(interaction: ChatInputCommandInteraction, deps: DiscordDeps): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const ctx = createDiscordCommandContext(interaction, deps.config, group === "guild" ? "guild" : "wallet");

  deps.logger.info(
    {
      subcommand,
      group,
      actorIdHash: ctx.actorIdHash,
      guildIdHash: ctx.guildIdHash,
      channelIdHash: ctx.channelIdHash
    },
    "incoming Discord slash command"
  );

  if (!group) {
    await replyToInteraction(
      interaction,
      "Use /ac wallet research for your private wallet or /ac guild research for the server wallet.",
      true
    );
    return;
  }

  if (group === "wallet" && subcommand === "balance") {
    await runBalanceCommand(ctx, deps);
    return;
  }

  if (group === "wallet" && subcommand === "deposit") {
    await runDepositCommand(ctx, deps);
    return;
  }

  if (group === "wallet" && subcommand === "cap") {
    await runCapCommand(ctx, deps, interaction.options.getString("amount") ?? "show");
    return;
  }

  if (group === "wallet" && subcommand === "history") {
    await runHistoryCommand(ctx, deps);
    return;
  }

  if (group === "wallet" && subcommand === "freeze") {
    deps.walletManager.freezeUserWallet(`discord:${interaction.user.id}`);
    await replyToInteraction(interaction, "Your wallet is frozen. Balance, deposit, and history still work.", true);
    return;
  }

  if (group === "wallet" && subcommand === "unfreeze") {
    deps.walletManager.unfreezeUserWallet(`discord:${interaction.user.id}`);
    await replyToInteraction(interaction, "Your wallet is active again.", true);
    return;
  }

  if (group === "wallet" && subcommand === "status") {
    const wallet = deps.walletManager.getUserWalletStatus(`discord:${interaction.user.id}`);
    await replyToInteraction(interaction, `Wallet status: ${wallet?.status ?? "not created"}.`, true);
    return;
  }

  if (group === "wallet" && subcommand === "policy") {
    const discordId = `discord:${interaction.user.id}`;
    const user = deps.db.getUserByTelegramId(discordId);
    const wallet = user ? deps.db.getWalletByUserId(user.id) : undefined;
    const confirmationCapUsdc = user ? deps.walletManager.getConfirmationCap(user) : undefined;
    const walletPolicy = wallet ? deps.db.getWalletPolicy(wallet.id) : undefined;

    const dailyCapLine =
      walletPolicy?.daily_cap_usdc !== null && walletPolicy?.daily_cap_usdc !== undefined
        ? `$${walletPolicy.daily_cap_usdc.toFixed(2)}`
        : deps.config.POLICY_DAILY_CAP_USDC !== undefined
        ? `$${deps.config.POLICY_DAILY_CAP_USDC.toFixed(2)} (global)`
        : "unlimited";

    const weeklyCapLine =
      walletPolicy?.weekly_cap_usdc !== null && walletPolicy?.weekly_cap_usdc !== undefined
        ? `$${walletPolicy.weekly_cap_usdc.toFixed(2)}`
        : deps.config.POLICY_WEEKLY_CAP_USDC !== undefined
        ? `$${deps.config.POLICY_WEEKLY_CAP_USDC.toFixed(2)} (global)`
        : "unlimited";

    await replyToInteraction(
      interaction,
      [
        `Wallet status: ${wallet?.status ?? "not created"}`,
        `Per-call cap: ${confirmationCapUsdc !== undefined ? `$${confirmationCapUsdc.toFixed(2)}` : "disabled"}`,
        `Daily cap: ${dailyCapLine}`,
        `Weekly cap: ${weeklyCapLine}`
      ].join("\n"),
      true
    );
    return;
  }

  if (group === "wallet" && subcommand === "research") {
    const query = interaction.options.getString("query", true);
    await runSkillCommand(ctx, deps, "research", query);
    return;
  }

  if (group === "guild") {
    await handleGuildCommand(interaction, deps, subcommand, ctx);
    return;
  }

  await replyToInteraction(interaction, "Unknown AgentCash command.", true);
}

async function handleGuildCommand(
  interaction: ChatInputCommandInteraction,
  deps: DiscordDeps,
  subcommand: string,
  ctx: CommandContext
): Promise<void> {
  if (!interaction.guildId) {
    await replyToInteraction(interaction, "Guild wallet commands must be run inside a Discord server.", true);
    return;
  }

  if (subcommand === "create") {
    assertDiscordGuildAdmin(interaction);
    const context = await deps.walletManager.getOrCreateDiscordGuildWallet({
      guildId: interaction.guildId,
      createdByDiscordId: interaction.user.id
    });
    deps.db.recordTelegramAdminVerification({
      groupId: context.group!.id,
      userId: context.user.id,
      telegramStatus: "administrator",
      source: "discord_permissions"
    });
    await replyToInteraction(
      interaction,
      [
        "Discord guild wallet is ready.",
        `Wallet address: ${WalletManager.maskAddress(context.wallet.address)}`,
        `Guild cap: $${(context.group?.spend_cap_usdc ?? deps.config.DEFAULT_SPEND_CAP_USDC).toFixed(2)}`
      ].join("\n"),
      true
    );
    return;
  }

  const context = await deps.walletManager.getDiscordGuildWalletForGuild(interaction.guildId, interaction.user.id);
  if (!context?.group) {
    await replyToInteraction(interaction, "No guild wallet exists yet. Ask a server manager to run /ac guild create.", true);
    return;
  }

  if (subcommand === "balance") {
    const { wallet, group, balance } = await deps.walletManager.getDiscordGuildBalance(
      interaction.guildId,
      interaction.user.id
    );
    await replyToInteraction(
      interaction,
      [
        `Guild wallet address: ${WalletManager.maskAddress(balance.address ?? wallet.address)}`,
        `Balance: ${typeof balance.usdcBalance === "number" ? `$${balance.usdcBalance.toFixed(2)} USDC` : "unavailable"}`,
        `Guild cap: ${group?.cap_enabled ? `$${group.spend_cap_usdc.toFixed(2)} USDC` : "off"}`
      ].join("\n"),
      true
    );
    return;
  }

  if (subcommand === "deposit") {
    const { deposit } = await deps.walletManager.getDiscordGuildDepositAddress(
      interaction.guildId,
      interaction.user.id
    );
    const isPublic = interaction.options.getBoolean("public") === true;
    await replyToInteraction(
      interaction,
      [
        `Guild deposit address: ${deposit.address ?? "unavailable"}`,
        deposit.depositLink ? `Deposit link: ${deposit.depositLink}` : "Deposit link: unavailable"
      ].join("\n"),
      !isPublic
    );
    return;
  }

  if (subcommand === "freeze") {
    assertDiscordGuildAdmin(interaction);
    deps.walletManager.freezeGroupWallet(context.group.id);
    await replyToInteraction(interaction, "Guild wallet is frozen. Balance, deposit, and history still work.", true);
    return;
  }

  if (subcommand === "unfreeze") {
    assertDiscordGuildAdmin(interaction);
    deps.walletManager.unfreezeGroupWallet(context.group.id);
    await replyToInteraction(interaction, "Guild wallet is active again.", true);
    return;
  }

  if (subcommand === "status") {
    const wallet = deps.db.getWalletByGroupId(context.group.id);
    await replyToInteraction(interaction, `Guild wallet status: ${wallet?.status ?? "not created"}.`, true);
    return;
  }

  if (subcommand === "cap") {
    assertDiscordGuildAdmin(interaction);
    deps.db.recordTelegramAdminVerification({
      groupId: context.group.id,
      userId: context.user.id,
      telegramStatus: "administrator",
      source: "discord_permissions"
    });
    const rawAmount = interaction.options.getString("amount") ?? "show";
    if (rawAmount.toLowerCase() === "show" || !rawAmount) {
      await replyToInteraction(
        interaction,
        `Guild cap: ${context.group.cap_enabled ? `$${context.group.spend_cap_usdc.toFixed(2)}` : "off"}`,
        true
      );
      return;
    }
    if (rawAmount.toLowerCase() === "off") {
      deps.walletManager.updateGroupCap(context.group.id, { enabled: false });
      await replyToInteraction(interaction, "Guild cap is now off.", true);
      return;
    }
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      await replyToInteraction(interaction, "Usage: /ac guild cap amount:<show|off|number>", true);
      return;
    }
    deps.walletManager.updateGroupCap(context.group.id, { amount, enabled: true });
    await replyToInteraction(interaction, `Guild per-call cap set to $${amount.toFixed(2)}.`, true);
    return;
  }

  if (subcommand === "history") {
    const entries = deps.db.getHistoryForGroup(context.group.id, 10);
    await replyToInteraction(
      interaction,
      entries.length === 0
        ? "No guild wallet transaction history yet."
        : ["Guild wallet transactions:", ...entries.map((entry, index) => `${index + 1}. ${entry.skill ?? "unknown"} ${entry.status}`)].join("\n"),
      true
    );
    return;
  }

  if (subcommand === "policy") {
    const walletPolicy = deps.db.getWalletPolicy(context.group.wallet_id);
    const perCallCap = deps.walletManager.getGroupConfirmationCap(context.group);
    const dailyCapLine =
      walletPolicy?.daily_cap_usdc !== null && walletPolicy?.daily_cap_usdc !== undefined
        ? `$${walletPolicy.daily_cap_usdc.toFixed(2)}`
        : `$${(deps.config.GROUP_DAILY_CAP_USDC ?? 25).toFixed(2)} (global)`;
    const weeklyCapLine =
      walletPolicy?.weekly_cap_usdc !== null && walletPolicy?.weekly_cap_usdc !== undefined
        ? `$${walletPolicy.weekly_cap_usdc.toFixed(2)}`
        : "unlimited";

    await replyToInteraction(
      interaction,
      [
        `Guild wallet status: ${deps.db.getWalletById(context.group.wallet_id)?.status ?? "not created"}`,
        `Per-call cap: ${perCallCap !== undefined ? `$${perCallCap.toFixed(2)}` : "disabled"}`,
        `Daily cap: ${dailyCapLine}`,
        `Weekly cap: ${weeklyCapLine}`
      ].join("\n"),
      true
    );
    return;
  }

  if (subcommand === "sync-admins") {
    assertDiscordGuildAdmin(interaction);
    const result = await syncDiscordGuildAdmins(interaction, deps, context.group.id);
    await replyToInteraction(
      interaction,
      `Guild wallet admin sync complete. Promoted: ${result.promoted}. Demoted: ${result.demoted}.`,
      true
    );
    return;
  }

  if (subcommand === "research") {
    const query = interaction.options.getString("query", true);
    await runSkillCommand(ctx, deps, "research", query);
    return;
  }
}

export async function handleButton(interaction: Interaction, deps: DiscordDeps): Promise<void> {
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
  const user = deps.db.upsertUser({
    telegramUserId: buttonContext.walletOwnerId,
    defaultSpendCapUsdc: deps.config.DEFAULT_SPEND_CAP_USDC
  });
  const quote = deps.db.getQuote(quoteId);
  const group = quote?.group_id ? deps.db.getGroupById(quote.group_id) : undefined;
  const requester = quote?.requester_user_id ? deps.db.getUserById(quote.requester_user_id) : undefined;
  const sessionChatId =
    group?.platform === "discord"
      ? interaction.guildId ?? buttonContext.chatId
      : requester?.telegram_user_id.startsWith("discord:")
      ? interaction.guildId
        ? `discord:user:${requester.telegram_user_id.slice("discord:".length)}:channel:${interaction.channelId}`
        : `discord:dm:${requester.telegram_user_id.slice("discord:".length)}`
      : buttonContext.chatId;
  const sessionUserId = quote?.requester_user_id ?? user.id;
  const session = deps.db.getSession(sessionUserId, sessionChatId);
  const sessionState = parseQuoteSessionState(session?.state_json ?? null);

  if (!sessionState || sessionState.quote_id !== quoteId) {
    await interaction.reply({ content: "This confirmation is no longer valid.", ephemeral: true });
    return;
  }

  if (isCancel) {
    const consumed = deps.db.consumeSessionState(sessionUserId, sessionChatId, session?.state_json ?? "");
    if (!consumed) {
      await interaction.reply({ content: "This confirmation was already used.", ephemeral: true });
      return;
    }

    deps.db.updateQuoteStatus(quoteId, "canceled");
    await clearDiscordComponents(interaction);
    await interaction.reply({ content: "Pending call cancelled.", ephemeral: true });
    return;
  }

  try {
    if (!group && quote?.requester_user_id !== user.id) {
      await interaction.reply({ content: "This confirmation does not belong to your account.", ephemeral: true });
      return;
    }

    if (group?.platform === "discord" && quote?.requires_group_admin_approval) {
      assertDiscordGuildAdmin(interaction);
      deps.db.recordTelegramAdminVerification({
        groupId: group.id,
        userId: user.id,
        telegramStatus: "administrator",
        source: "discord_permissions"
      });
    }

    const result = await deps.skillExecutor.executeApprovedQuote(quoteId, {
      telegramId: buttonContext.walletOwnerId,
      telegramChatId: group?.platform === "discord" ? interaction.guildId ?? buttonContext.chatId : sessionChatId,
      telegramChatType: group?.platform === "discord" ? "discord_guild" : "private",
      telegramMessageId: interaction.id
    });

    deps.db.consumeSessionState(sessionUserId, sessionChatId, session?.state_json ?? "");
    await clearDiscordComponents(interaction);
    await interaction.reply({ content: result.text, ephemeral: true });
  } catch (error) {
    if (error instanceof QuoteError) {
      await clearDiscordComponents(interaction);
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }
    throw error;
  }
}

async function clearDiscordComponents(interaction: Interaction): Promise<void> {
  if (!interaction.isMessageComponent()) {
    return;
  }

  await interaction.message.edit({ components: [] }).catch(() => undefined);
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
