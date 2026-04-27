# Leaked Bot Token

## Symptoms

- Unexpected Telegram or Discord bot activity.
- Webhook updates from unknown sources.
- Platform dashboards show token use from unfamiliar IPs.

## Immediate Mitigation

- Revoke and rotate the affected platform token immediately.
- Stop app instances using the leaked token.
- Keep `WEBHOOK_SECRET_TOKEN` enabled for Telegram webhook mode.

## Commands / Env Changes

```bash
TELEGRAM_BOT_TOKEN=<new-token>
DISCORD_BOT_TOKEN=<new-token>
corepack pnpm db:migrate
docker compose -f docker-compose.demo.yml up -d --build
```

For Telegram, reset the webhook after rotation.

## Data To Preserve

- Platform audit logs.
- App logs around first suspicious update.
- `audit_events`, `preflight_attempts`, and `transactions`.

## Recovery

- Deploy the new token.
- Confirm `/healthz` and `/readyz`.
- Run the manual Telegram/Discord smoke checklist without funds first.

## Postmortem Notes

- Identify where the token leaked.
- Rotate adjacent secrets if the storage location was shared.
- Add monitoring for unexpected platform update volume.
