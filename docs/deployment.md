# Deployment

This repo is demo-oriented. The Docker files are useful for local demos and dependency scaffolding, but they are not a production custody deployment.

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
AUDIT_STRICT_MODE=false
NODE_ENV=development
```

## Demo Compose

The demo compose file runs the app with SQLite, local locks, file audit logs, and demo/local custody. It sets `NODE_ENV=development` and does not use `ALLOW_SQLITE_IN_PRODUCTION`.

```bash
cp .env.example .env
docker compose -f docker-compose.demo.yml up --build
```

This mode proves:

- the container image builds
- the app can boot with SQLite
- `/readyz` can check the local database, lock provider, custody health setting, and platform config
- `/healthz` remains available as process liveness only

This mode does not prove:

- production database readiness
- multi-instance safety
- remote signer/KMS custody
- production-grade immutable audit storage
- funded live AgentCash behavior when `SKIP_AGENTCASH_HEALTHCHECK=true`

The demo compose defaults `SKIP_AGENTCASH_HEALTHCHECK=true` so the container can boot without a configured AgentCash CLI or funded wallet. If you set it to `false`, `/readyz` and startup depend on AgentCash CLI health.

Health endpoints:

```bash
curl http://localhost:3001/healthz
curl http://localhost:3001/readyz
curl http://localhost:3001/metrics
```

`/healthz` only proves the process is alive. The compose healthcheck uses `/readyz` because readiness includes dependency checks.

Optional audit sink mock:

```bash
docker compose -f docker-compose.demo.yml --profile audit-mock up --build
```

## Postgres Scaffold

Postgres is not included in the demo app compose path because the runtime repository still uses SQLite. Postgres is a migration scaffold and future production DB target only; the runtime adapter is not implemented.

To start a local Postgres service for migration scaffolding only:

```bash
docker compose --profile postgres-scaffold up
```

What this proves:

- a local Postgres container can start
- migrations can be tested separately with `corepack pnpm db:migrate`

What it does not prove:

- the live app uses Postgres as its runtime repository
- production storage is complete
- SQLite has been replaced for bot command execution

Migration test example:

```bash
DATABASE_PROVIDER=postgres \
DATABASE_URL=postgres://agentcash:agentcash@localhost:5432/agentcash \
corepack pnpm db:migrate
```

## Production Skeleton

`docker-compose.prod-skeleton.yml` documents the shape of a future production deployment. It is intentionally not a custody-ready compose file.

```bash
docker compose -f docker-compose.prod-skeleton.yml config
```

The skeleton requires production-shaped settings:

- `DATABASE_PROVIDER=postgres`
- managed `DATABASE_URL`
- `LOCK_PROVIDER=redis`
- managed `REDIS_URL`
- `AUDIT_SINK=http`
- external `AUDIT_HTTP_ENDPOINT`
- `CUSTODY_MODE=remote_signer`
- reviewed `REMOTE_SIGNER_URL`
- pinned `AGENTCASH_ARGS`

The skeleton does not prove production readiness. Today, app startup with `DATABASE_PROVIDER=postgres` fails before partially starting with: `Postgres runtime adapter is not implemented yet. Use SQLite for local demo or implement PostgresAdapter before production.` Remote signer/KMS custody is also not implemented as a reviewed production boundary.

## Required Secrets

- `MASTER_ENCRYPTION_KEY`
- at least one of `TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID` when Discord is enabled
- `WEBHOOK_SECRET_TOKEN` when `BOT_MODE=webhook`
- `REDIS_URL` when `LOCK_PROVIDER=redis`
- `DATABASE_URL` when `DATABASE_PROVIDER=postgres`
- `AUDIT_HTTP_ENDPOINT` when `AUDIT_SINK=http`
- `REMOTE_SIGNER_URL` when `CUSTODY_MODE=remote_signer`

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
- Do not claim managed Postgres runtime support until the repository adapter is fully wired and tested.
- Keep `AUDIT_SINK=file` or `AUDIT_SINK=http`; database-only audit is not enough for production.
- Set `AUDIT_STRICT_MODE=true` when readiness should fail if external audit shipping is unhealthy.

## Operational Caveats

- `/healthz` only proves the process is alive.
- `/readyz` checks dependencies and is the correct readiness endpoint.
- SQLite is demo/local only and not horizontally safe.
- Redis locks do not replace DB idempotency.
- Custody remains demo-only unless remote signer/KMS is completed and reviewed.
