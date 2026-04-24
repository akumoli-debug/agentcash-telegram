# Custody Review

This app is safe enough for controlled demos with small caps. It is not production-custody-safe.

## Key Storage

Wallet private key material is encrypted at rest with AES-256-GCM using `MASTER_ENCRYPTION_KEY`. The encrypted value is stored in SQLite.

This protects against casual database disclosure only if the attacker does not also have the master key, process environment, backups, host access, or running process memory.

Production blockers:

- no managed KMS/HSM
- no envelope encryption
- no per-wallet key hierarchy
- no key access audit trail outside app logs
- no separation between application runtime and custody authority

## Key Rotation

There is no implemented rotation procedure for:

- `MASTER_ENCRYPTION_KEY`
- Telegram bot token
- Discord bot token
- optional router API keys
- wallet private keys

Production needs tested rotation playbooks, dual-read/write migration support, rollback handling, and incident drills.

## Process Memory Exposure

Private keys are decrypted into process memory before invoking AgentCash CLI. The code does not zero buffers after use. A compromised host, runtime inspector, crash dump, or malicious dependency could expose decrypted key material.

## AgentCash CLI Subprocess Risk

The AgentCash CLI is trusted code. It receives decrypted wallet private keys through environment variables and runs as a child process.

Risks:

- malicious or compromised CLI package
- dependency confusion if `npx` fetches an unexpected version
- child process environment exposure
- raw CLI output accidentally changing shape
- filesystem artifacts in AgentCash home directories

Production needs pinned binaries, supply-chain verification, sandboxing, and a clearer custody boundary.

## Hosted Secret Management

Docker Compose reads secrets from `.env`. That is acceptable for local testing, not real production.

Production needs:

- platform secret manager or KMS-backed injection
- least-privilege runtime identity
- secret access audit logs
- strict backup handling
- no secrets in images, logs, shell history, or compose files

## Limits and Caps

The app has important spend controls:

- quote-before-execute
- immutable canonical request JSON
- per-call cap
- hard MVP cap
- confirmation for over-cap and natural-language routed requests
- SQL-level quote replay protection

These reduce blast radius, but they do not solve custody. If the host or master key is compromised, the attacker may be able to spend from wallets outside normal command paths.

## Incident Response

Missing today:

- key compromise runbook
- wallet freezing/disable workflow beyond DB status fields
- bulk key rotation
- alerting on failed payment spikes
- alerting on replay attempts
- audit log export to immutable storage
- customer/user notification plan

## Safe for Demo

Reasonable demo use:

- small balances
- low hard cap
- local or single-instance deployment
- test bot tokens
- controlled users
- no production customer funds

## Unsafe for Production Custody

Do not use this as real production custody until at least these are complete:

- managed KMS/HSM-backed key management
- Postgres or equivalent production database with migrations
- distributed locks tested across replicas
- pinned and sandboxed AgentCash execution
- secret rotation and incident response procedures
- immutable audit log shipping
- custody threat model reviewed by security and legal stakeholders
