# Gateway Security

The gateway security layer evaluates every inbound event before any command executes. It is the first defence boundary between the platform transport and the wallet/payment logic.

## Architecture

```
Platform event (Telegram message / Discord interaction)
  │
  ▼
GatewaySecurityPolicy (src/gateway/securityPolicy.ts)
  │   • bot self-message check
  │   • callback query pass-through
  │   • allowlist / pairing gate
  │   • private-wallet command guard
  │   • group require-mention check
  ▼
Command handler or silent drop
```

The policy is a pure function — no database calls, no side effects. Inputs use pre-hashed IDs; raw platform IDs never enter the function.

## Policy Inputs

| Field | Type | Description |
|---|---|---|
| `platform` | `telegram \| discord` | Originating platform |
| `actorIdHash` | string | HMAC-SHA256 of the raw platform user ID, sliced to 24 chars |
| `chatIdHash` | string | HMAC-SHA256 of `chat:<rawChatId>`, sliced to 24 chars |
| `chatType` | `private \| group \| guild \| channel` | Chat context |
| `isCommand` | boolean | True if the message starts with `/` |
| `commandName` | string? | Slash command name without `/` or `@` suffix |
| `botWasMentioned` | boolean | True if the message explicitly mentions the bot |
| `messageAuthorIsBot` | boolean | True if `from.is_bot` is set |
| `walletScopeRequested` | `user \| group \| guild \| none` | Inferred wallet scope |
| `isCallbackQuery` | boolean | True for button confirm/cancel callbacks |

## Policy Decisions

| Result | Meaning |
|---|---|
| `allow` | Proceed to command handler |
| `deny_silent` | Drop silently — no reply |
| `deny_with_dm_instruction` | Reply: "DM me for private wallet commands. Use /groupwallet help here." |
| `deny_with_allowlist_message` | Reply: restricted to approved users, contact operator |
| `require_pairing` | Issue pairing code and reply with instructions |

## Decision Rules (in order)

1. **Bot self-message**: `messageAuthorIsBot = true` → `deny_silent` (always, no exceptions).
2. **Callback query**: `isCallbackQuery = true` → `allow` (ownership verified by the handler).
3. **Allowlist gate**: if `GATEWAY_ALLOW_ALL_USERS=false` and actor not in allowlist:
   - `PAIRING_MODE=dm_code` + group chat → `deny_silent`
   - `PAIRING_MODE=dm_code` + private chat → `require_pairing`
   - otherwise → `deny_with_allowlist_message`
4. **Private-wallet command guard**: group/guild chat + private-wallet command → `deny_with_dm_instruction`.
5. **Group require-mention**: group chat + not a command + bot not mentioned → `deny_silent`.
6. Otherwise → `allow`.

## Environment Variables

### Allowlist

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_ALLOW_ALL_USERS` | `false` | Skip allowlist entirely. **Never set true in production.** |
| `TELEGRAM_ALLOWED_USERS` | *(empty)* | Comma-separated raw Telegram numeric user IDs. Hashed at startup. |
| `DISCORD_ALLOWED_USERS` | *(empty)* | Comma-separated raw Discord user IDs. Hashed at startup. |
| `GATEWAY_ALLOWED_USERS` | *(empty)* | Cross-platform IDs with prefix: `tg:123` or `dc:456`. |

Raw IDs from these variables are hashed with the master key at startup using the same algorithm as the bot middleware. They are never logged or stored in their raw form.

### Pairing

| Variable | Default | Description |
|---|---|---|
| `PAIRING_MODE` | `disabled` | `disabled` or `dm_code`. With `dm_code`, unknown users receive an 8-char OTP in a private DM. |
| `PAIRING_CODE_TTL_SECONDS` | `3600` | How long a code is valid after issuance. |

### Group Behaviour

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_GROUP_REQUIRE_MENTION` | `true` | Plain group text messages require `@BotName` before routing. |
| `DISCORD_GUILD_REQUIRE_MENTION` | `true` | Natural language in guilds requires `@Bot` mention. Slash commands always pass. |
| `GROUP_FREE_RESPONSE_CHAT_IDS` | *(empty)* | Comma-separated pre-computed hashed chat IDs that bypass the require-mention rule. |

## Private-Wallet Command Guards

The following Telegram commands may only execute in private chat (`/start`, `/deposit`, `/balance`, `/cap`, `/history`, `/research`, `/enrich`, `/generate`). In a group, the bot replies:

> DM me for private wallet commands. Use /groupwallet help here.

These responses never include deposit addresses, balances, or history.

Discord `/ac wallet` subcommands use ephemeral replies and are restricted to DM by the slash command context restriction.

## Pairing Flow

```
User DMs bot (unknown actor)
  → policy: require_pairing
  → bot issues 8-char code, replies in DM only
  → user shares code with operator

Operator runs:
  npx tsx scripts/approve-pairing.ts <code>
  → marks code as approved in DB
  → recommends adding actor hash to TELEGRAM_ALLOWED_USERS for persistence

To revoke:
  npx tsx scripts/revoke-user.ts telegram <actor-id-hash>
```

Codes are:
- 8 hex characters (4 random bytes) — approximately 4 billion combinations
- Stored as SHA-256 hash (the raw code is never written to the DB)
- Valid for `PAIRING_CODE_TTL_SECONDS` from issuance
- A new `/pair` command expires any previous pending code for that actor
- Revoked by operator at any time via the `revoke-user.ts` script

## Bot Self-Message Ignore

All messages where `from.is_bot = true` are silently dropped at the first middleware layer. This prevents:
- Feedback loops (bot replies to its own messages)
- Synthetic/system messages triggering command handling
- Bot-to-bot relay attacks

## Security Defaults

| Concern | Default | Why |
|---|---|---|
| Unknown user access | **denied** | Wallets handle real funds; unknown actors have no access |
| Pairing mode | `disabled` | Pairing is optional UX feature; disabled keeps surface minimal |
| Group mention required | **true** | Prevents ambient group messages from triggering paid calls |
| Private commands in groups | **blocked** | Balance, deposit address, history never appear in group replies |
| Bot self-messages | **dropped** | Prevents loops and synthetic message handling |
| Pairing in groups | **never** | Codes always delivered in private DM |

## Audit Trail

All pairing events are logged to the audit log:

- `gateway_pairing.code_issued` — when a code is issued
- `gateway_pairing.code_approved` — when an operator approves
- `gateway_pairing.codes_revoked` — when codes are revoked

Policy denials are silent (no audit event) to avoid log flooding from unknown actors.

## Adding a New Allowed User

1. Find the user's raw platform ID (shown in Telegram: forward a message to @userinfobot; in Discord: enable Developer Mode and right-click the user).
2. Add to the appropriate env var and restart:
   ```
   TELEGRAM_ALLOWED_USERS=123456789,987654321
   ```
3. Alternatively use pairing mode for self-service onboarding.

## Database Table

```sql
CREATE TABLE gateway_pairing_codes (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  actor_id_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,              -- SHA-256 of the raw code
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT
);
```
