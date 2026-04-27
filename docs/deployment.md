# Deployment

This app can be deployed for demos and staging-like operation. It is not production-custody-safe.

## Local Dev

```bash
nvm install
nvm use
corepack enable
cp .env.example .env
openssl rand -base64 32
corepack pnpm install
corepack pnpm dev
```

Use SQLite and local locks for local dev:

```bash
DATABASE_PROVIDER=sqlite
LOCK_PROVIDER=local
AUDIT_SINK=database
NODE_ENV=development
```

## Staging

Use the same config shape as production, but keep balances small and caps low:

```bash
NODE_ENV=production
DATABASE_PROVIDER=sqlite
ALLOW_SQLITE_IN_PRODUCTION=true
LOCK_PROVIDER=redis
REDIS_URL=redis://redis:6379
AUDIT_SINK=file
HARD_SPEND_CAP_USDC=1
SKIP_AGENTCASH_HEALTHCHECK=false
ALLOW_UNQUOTED_DEV_CALLS=false
```

The compose file includes Postgres and Redis. The app still uses SQLite by explicit override because the Postgres repository layer is not fully wired yet. Postgres migrations can be tested with `corepack pnpm db:migrate`.

## Production-Like Compose

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:3001/healthz
curl http://localhost:3001/readyz
curl http://localhost:3001/metrics
```

Services:

- `app`
- `postgres`
- `redis`
- optional `audit-sink-mock` profile

Audit sink mock:

```bash
docker compose --profile audit-mock up --build
```

## Required Secrets

- `MASTER_ENCRYPTION_KEY`
- at least one of `TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID` when Discord is enabled
- `WEBHOOK_SECRET_TOKEN` when `BOT_MODE=webhook`
- `REDIS_URL` when `LOCK_PROVIDER=redis`
- `DATABASE_URL` when `DATABASE_PROVIDER=postgres`
- `AUDIT_HTTP_ENDPOINT` when `AUDIT_SINK=http`

## Telegram Webhook

```bash
BOT_MODE=webhook
WEBHOOK_DOMAIN=https://your-public-domain.example
WEBHOOK_PATH=/telegram/webhook
WEBHOOK_SECRET_TOKEN=<long-random-secret>
```

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_DOMAIN}${WEBHOOK_PATH}" \
  -d "secret_token=${WEBHOOK_SECRET_TOKEN}"
```

Terminate HTTPS at the platform/load balancer. The app itself does not provide TLS.

## Discord Commands

For dev guild instant updates:

```bash
DISCORD_DEV_GUILD_ID=<guild-id>
corepack pnpm start
```

Global Discord commands can take time to propagate.

## Railway / Fly / Render Notes

- Set secrets through the platform secret manager, not `.env` committed to git.
- Expose the webhook port and health port according to the platform model.
- Use managed Redis for `LOCK_PROVIDER=redis`.
- Use managed Postgres only after the repository adapter is fully wired and tested.
- Keep `AUDIT_SINK=file` or `AUDIT_SINK=http`; database-only audit is not enough for production.

## Operational Caveats

- `/healthz` only proves the process is alive.
- `/readyz` checks dependencies.
- SQLite in production requires an explicit unsafe override and is not horizontally safe.
- Redis locks do not replace DB idempotency.
- Custody remains demo-only unless remote signer/KMS is completed and reviewed.
