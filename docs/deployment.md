# Deployment Scaffold

This is deployment scaffolding for demos and staging-like testing. It is not a claim that the app is production-custody-safe.

## Local Production-Like Run

1. Create `.env`:

```bash
cp .env.example .env
openssl rand -base64 32
```

Set at least:

```bash
MASTER_ENCRYPTION_KEY=...
TELEGRAM_BOT_TOKEN=...
```

2. Start with Docker Compose:

```bash
docker compose up --build
```

3. Check health:

```bash
curl http://localhost:3001/healthz
```

The health endpoint only confirms the Node process is running. It does not prove AgentCash CLI health, webhook reachability, database durability, or custody safety.

## Webhook Mode

Webhook mode is enabled with:

```bash
BOT_MODE=webhook
WEBHOOK_DOMAIN=https://your-public-domain.example
WEBHOOK_PATH=/telegram/webhook
WEBHOOK_HOST=0.0.0.0
WEBHOOK_PORT=3000
WEBHOOK_SECRET_TOKEN=<long-random-secret>
```

`WEBHOOK_SECRET_TOKEN` is required whenever `BOT_MODE=webhook`. Startup validation rejects webhook mode without it.

Telegram webhook setup:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_DOMAIN}${WEBHOOK_PATH}" \
  -d "secret_token=${WEBHOOK_SECRET_TOKEN}"
```

The public URL must terminate HTTPS before traffic reaches the app. The Docker Compose file exposes port `3000`, but it does not provide TLS; put it behind a real reverse proxy or platform load balancer.

## Docker

Files:

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`

The image runs:

```bash
corepack pnpm start
```

Data volumes:

- `/app/.data` for SQLite
- `/app/data/agentcash-homes` for AgentCash isolated home directories

These volumes contain sensitive metadata and encrypted wallet material. Protect and back them up accordingly.

## SQLite Is Local-Only

SQLite remains the default because it is simple for local demos and tests. It is not suitable for horizontally scaled production:

- no cross-process write coordination beyond SQLite file locks
- no managed backup/restore workflow here
- no online migration framework
- no distributed transaction or advisory-lock integration

Tables that need a real migration plan before production:

- `users`
- `delivery_identities`
- `groups`
- `group_members`
- `wallets`
- `quotes`
- `transactions`
- `preflight_attempts`
- `audit_events`
- `inline_payloads`
- `sessions`
- `request_events`

`src/db/adapter.ts` contains a small adapter seam and a Postgres migration TODO list. There is no partial Postgres implementation because the tests and transactional behavior have not been migrated end to end.

## Locks

The app now uses a `LockManager` interface with a `LocalLockManager` implementation. Local locks protect wallet provisioning, quote approval, and paid execution inside one Node process.

This does not protect multiple replicas. Real production needs a distributed lock with:

- TTL
- unique ownership token
- compare-and-delete release script
- monitoring for lock contention and expired locks
- tests under multi-process execution

Redis is not wired in this scaffold because an unsafe lock is worse than no lock.
