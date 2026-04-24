# Group Wallets

Group wallets are experimental support for Telegram groups. They reuse the existing `wallets` table with `kind='group'`; there is no second wallet system.

## Model

- `groups.telegram_chat_id_hash` stores a keyed hash of the Telegram chat ID.
- `groups.title_hash` stores a keyed hash of the group title when available.
- `groups.wallet_id` points at the group wallet row.
- `group_members` stores local membership and role: `owner`, `admin`, or `member`.
- The creator of `/groupwallet create` becomes the owner.
- Paid calls in private chats continue to use the user's wallet.
- Paid calls in group chats use the group wallet only after `/groupwallet create`.
- Transactions store both the group wallet and the acting requester user, so history can be queried by group and by user.

## Commands

Run these inside the Telegram group:

```text
/groupwallet create
/groupwallet deposit
/groupwallet balance
/groupwallet members
/groupwallet history
/groupwallet cap <amount>
/groupwallet help
```

`/groupwallet create` is idempotent. Running it again returns the existing group wallet instead of provisioning a second one.

## Permissions

- Owners and admins can change the group cap.
- Members can request paid calls under the group cap.
- Calls over the group cap require owner/admin confirmation.
- Confirmation executes the immutable quote record. Callback handling never re-parses the original Telegram message.
- Confirmation is atomically consumed by the quote status transition, so replayed callbacks cannot execute twice.

## Limitations

- Telegram admin status is not synced yet. Only the wallet creator is automatically an owner; additional admins require a future role-management command or direct database update.
- Owner/admin approval is enforced, but there is not yet a full multi-step approval queue.
- Membership is discovered when a user interacts with the group wallet.
- This remains MVP custody: the operator controls encrypted wallet material and `MASTER_ENCRYPTION_KEY`.
