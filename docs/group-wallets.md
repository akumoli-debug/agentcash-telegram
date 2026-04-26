# Group Wallets

**Experimental but real.** Group wallets are Telegram-admin-gated, quote-bound, and covered by tests, but they still concentrate shared funds under one bot-controlled wallet and are not production custody.

## Model

- `groups.telegram_chat_id_hash` stores a keyed hash of the Telegram chat ID.
- `groups.title_hash` stores a keyed hash of the group title when available.
- `groups.wallet_id` points at the group wallet row.
- `group_members` stores local role state: `owner`, `admin`, or `member`.
- `telegram_admin_verifications` records recent Telegram admin checks for high-risk actions.
- The first Telegram creator/administrator to run `/groupwallet create` becomes the original wallet owner.
- Paid calls in group chats use the group wallet only after `/groupwallet create`.
- Transactions store both the group wallet and the acting requester user.

Internal roles are not enough for high-risk actions. Changing caps and approving over-cap group quotes require both:

1. Internal `owner` or `admin` role.
2. Fresh Telegram `creator` or `administrator` verification, valid for 5 minutes.

## Telegram Setup

Required:

- Add the bot to the Telegram group or supergroup.
- Make the bot a group admin for reliable verification.
- The bot must be able to call `getChatMember` and `getChatAdministrators`.

Recommended permissions:

- Read messages, so commands reach the bot.
- No posting/pinning/invite permissions are required for wallet verification.

Privacy mode:

- With privacy mode enabled, Telegram only sends commands, replies, and mentions to the bot. Slash commands like `/groupwallet create` still work.
- If you want natural-language group requests, privacy mode may prevent the bot from seeing ordinary messages. Slash commands remain the safer path.

Inline mode:

- Inline mode is configured separately in BotFather.
- Inline previews must not be treated as group wallet execution; paid execution still goes through quote confirmation.

## Commands

Run these inside the Telegram group:

```text
/groupwallet create
/groupwallet deposit
/groupwallet balance
/groupwallet roles
/groupwallet sync-admins
/groupwallet history
/groupwallet cap <amount>
/groupwallet help
```

`/groupwallet create` is idempotent. Running it again never overwrites the owner. If the existing owner is no longer a Telegram admin, another Telegram admin must run `/groupwallet sync-admins`.

`/groupwallet sync-admins`:

- fetches current Telegram admins
- promotes known Telegram admins to internal admin
- demotes internal admins who are no longer Telegram admins
- keeps the original owner as owner while they are still in the chat
- replies with counts only, never names

`/groupwallet roles` shows role counts and reminds the group:

```text
Telegram admins control group wallet admin rights. Run /groupwallet sync-admins after admin changes.
```

## Anti-Front-Run Behavior

- A non-admin cannot create a group wallet.
- If Telegram verification fails, creation and admin actions fail closed.
- A later member cannot rerun `/groupwallet create` to become owner.
- Internal admins who lose Telegram admin status cannot change caps or approve over-cap group quotes.
- `/groupwallet sync-admins` is the supported recovery path after Telegram admin changes.

## Limitations

- Admin sync runs when `/groupwallet sync-admins` is invoked; it is not continuous background reconciliation.
- Telegram admins who have never interacted with the bot may be counted as unknown until a local `users` row exists.
- There is no quorum or multi-admin approval policy.
- Any verified internal owner/admin can approve an over-cap group quote.
- The group wallet remains local custody controlled by the operator and `MASTER_ENCRYPTION_KEY`.
- SQLite and process-local locks remain unsuitable for distributed production.
