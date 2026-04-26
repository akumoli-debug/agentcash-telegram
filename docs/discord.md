# Discord

Discord is now split into two explicit wallet surfaces:

- **DM/user wallets**: stable experimental surface for a single Discord user.
- **Guild wallets**: experimental server wallet surface, gated by Discord `Manage Server` or `Administrator`.

This is still not a production custody claim. Discord uses the same local SQLite, local locks, AgentCash CLI subprocess, and local key custody caveats as Telegram.

## Setup

1. Create an app in the Discord Developer Portal.
2. Add a bot user and copy the bot token.
3. Copy the application ID.
4. Install the app with:

```text
bot
applications.commands
```

5. Configure:

```bash
DISCORD_BOT_TOKEN=replace-me
DISCORD_APPLICATION_ID=replace-me
DISCORD_DEV_GUILD_ID=optional-dev-server-id
```

If `DISCORD_DEV_GUILD_ID` is set, commands register to that guild for fast development updates. Without it, commands register globally for production and Discord propagation can take minutes.

## Command List

Private user wallet:

```text
/ac wallet balance
/ac wallet deposit
/ac wallet cap amount:<show|off|number>
/ac wallet history
/ac wallet research query:<query>
```

Experimental guild wallet:

```text
/ac guild create
/ac guild balance
/ac guild deposit public:<true|false>
/ac guild cap amount:<show|off|number>
/ac guild history
/ac guild sync-admins
/ac guild research query:<query>
```

The top-level `/ac research` path is intentionally not used for guild paid calls. In a server, users must choose `/ac wallet research` for their private wallet or `/ac guild research` for the server wallet.

## Permissions

Guild wallet admin actions require current Discord permissions:

- `Manage Server`, or
- `Administrator`

This applies to:

- `/ac guild create`
- `/ac guild cap`
- `/ac guild sync-admins`
- approving over-cap guild wallet quotes

Internal `group_members` roles mirror Discord permission state, but they do not replace Discord permission checks. `/ac guild sync-admins` reconciles known Discord managers/admins into internal admin rows and demotes stale internal admins.

## Ephemeral Behavior

- User wallet balance, deposit, cap, history, and confirmations are ephemeral.
- Guild wallet balance is ephemeral by default.
- Guild wallet deposit is ephemeral by default.
- Guild wallet deposit can be posted publicly only with `public:true`.
- Paid-call confirmations are ephemeral.

## Guild Wallet Semantics

Guild wallets reuse the group wallet storage path with `platform='discord'` and a hashed guild ID. Telegram group wallet logic continues to use `platform='telegram'`.

| Context | Wallet Used |
| --- | --- |
| Discord DM `/ac wallet ...` | Discord user wallet |
| Discord server `/ac wallet ...` | Discord user wallet, shown ephemerally |
| Discord server `/ac guild ...` | Discord guild wallet |
| Discord server ambiguous/default paid call | Refused; user must choose wallet or guild |

## Caveats

- Guild admin sync is command-driven, not continuous.
- Only known users can be promoted into internal admin rows.
- No quorum policy exists; a verified guild admin can approve an over-cap guild quote.
- Command contexts/integration metadata is included in the command payload where this Discord.js version allows raw fields, but subcommand-level placement is still enforced by handler checks.
