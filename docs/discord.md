# Discord MVP

The Discord port is a thin adapter over the shared command layer. It does not copy Telegram command business logic.

## Architecture

Discord interactions are converted into the transport-neutral `CommandContext` interface:

- `platform: "discord"`
- hashed actor/guild/channel identifiers for logs and command history
- `reply()` for normal output
- `replyPrivateOrEphemeral()` for wallet-sensitive output
- `confirm()` for quote confirmation buttons
- `walletScope` describing whether the interaction is a direct-message user wallet or a guild scope

The shared command layer then calls the same `WalletManager` and `SkillExecutor` used by Telegram. Quote creation, spending caps, immutable canonical requests, atomic approval, and replay protection are unchanged.

## Current Scope

Supported slash commands:

```text
/ac balance
/ac deposit
/ac research query:<query>
```

Direct messages use user wallets.

Guild/server channels currently return an honest limitation message for paid wallet commands: Discord guild wallets are not enabled until there is an explicit guild wallet creation flow. This avoids silently charging a user wallet from a server channel.

## Discord Setup

1. Create an app in the Discord Developer Portal.
2. Add a bot user and copy its token.
3. Copy the application ID from General Information.
4. Enable the bot scopes needed for installation:

```text
bot
applications.commands
```

5. Set environment variables:

```bash
DISCORD_BOT_TOKEN=replace-me
DISCORD_APPLICATION_ID=replace-me
```

6. Start the app:

```bash
corepack pnpm dev
```

On startup, the app registers the global `/ac` slash command set. Global command propagation can take a few minutes in Discord.

## Local Demo

In a direct message with the bot:

```text
/ac balance
/ac deposit
/ac research query:latest x402 ecosystem activity
```

If the research quote is above the user's cap, the bot replies ephemerally with Confirm and Cancel buttons. Confirm executes the stored quote; replayed button clicks are rejected by the same SQL-level quote transition used by Telegram.

## Safety Notes

- Wallet address, deposit, and balance responses are ephemeral.
- Discord usernames and message content are not logged by default.
- Research query text is passed to the paid endpoint only after the normal quote path accepts it.
- Guild wallet custody is intentionally not implemented in this MVP.
