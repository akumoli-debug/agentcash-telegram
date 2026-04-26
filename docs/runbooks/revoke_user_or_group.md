# Revoke User Or Group

## Symptoms

- User or group should no longer spend.
- Admin membership changed after suspicious activity.
- Group/guild wallet needs emergency pause.

## Immediate Mitigation

- Freeze the affected wallet.
- For Telegram groups, run `/groupwallet sync-admins` after admin changes.
- For Discord guilds, run `/ac guild sync-admins`.

## Commands / Env Changes

```bash
/freeze
/status
/groupwallet sync-admins
/ac guild freeze
/ac guild status
```

## Data To Preserve

- Audit events for admin changes.
- Platform admin membership history.
- Recent quotes and transactions.

## Recovery

- Confirm the correct owner/admin set.
- Unfreeze only after the group/guild admin state is synced.
- Keep caps low during reactivation.

## Postmortem Notes

- Document who requested revocation.
- Record whether the issue was access control, compromised account, or policy change.
