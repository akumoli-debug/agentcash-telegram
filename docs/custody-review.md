# Custody Review

This app is safe enough for controlled demos with small caps. It is not production-custody-safe.

## Current Boundary

The code now has a signer abstraction in `src/custody/`:

- `local_cli`: demo-only wrapper around the current AgentCash CLI behavior.
- `local_encrypted`: local encrypted-key boundary for experiments; not production-intended.
- `remote_signer`: intended production path for a separate signer service.
- `kms`: intended production path for KMS/HSM integration, currently a fail-closed stub.

`AgentCashClient` no longer decrypts private keys directly. Decryption and `X402_PRIVATE_KEY` environment passing are isolated inside `LocalCliSigner`.

## Mode Truth Table

| Mode | Current status | Production posture |
|---|---|---|
| `local_cli` | Implemented for local demos. Uses encrypted keys at rest, decrypts in process, and passes the key to the trusted CLI via environment variable. | Rejected in `NODE_ENV=production` unless `ALLOW_INSECURE_LOCAL_CUSTODY=true`. Still not production custody. |
| `local_encrypted` | Boundary exists, but no reviewed payment signer is wired. | Not production-intended. |
| `remote_signer` | HTTP client stub exists and requires `REMOTE_SIGNER_URL`. | Preferred production path once the signer service exists, is reviewed, and signs without exposing keys to the app. |
| `kms` | Stub exists and fails with a clear error. | Intended future production path after real KMS/HSM signing is implemented and reviewed. |

## Key Storage

Wallet private key material is still encrypted at rest with AES-256-GCM using `MASTER_ENCRYPTION_KEY` when using local demo custody. The encrypted value remains in SQLite for compatibility.

This protects only against casual database disclosure if the attacker does not also have the master key, process environment, backups, host access, or running process memory.

Production blockers:

- no implemented remote signer or KMS/HSM signer
- no envelope encryption
- no per-wallet managed key hierarchy
- no immutable external key access audit trail
- no separation between application runtime and custody authority

## Key Rotation

Local/demo key version tables now exist:

- `key_versions`
- `wallet_keys`
- `wallets.active_key_version`

Local demo rotation records a new active key version, marks prior local key versions deprecated, and writes a `key_rotated` audit event. It does not move funds automatically and does not destroy old keys while funds may remain.

There is still no production-ready rotation procedure for:

- `MASTER_ENCRYPTION_KEY`
- Telegram bot token
- Discord bot token
- optional router API keys
- remote signer keys
- KMS/HSM keys

See [key-rotation.md](key-rotation.md).

## Process Memory Exposure

In `local_cli`, private keys are decrypted into process memory before invoking AgentCash CLI. The code does not zero buffers after use. A compromised host, runtime inspector, crash dump, or malicious dependency could expose decrypted key material.

## AgentCash CLI Subprocess Risk

The AgentCash CLI is trusted code in demo mode. It receives decrypted wallet private keys through environment variables and runs as a child process.

Risks:

- malicious or compromised CLI package
- dependency confusion if `npx` fetches an unexpected version
- child process environment exposure
- filesystem artifacts in AgentCash home directories
- no production-reviewed signing policy boundary

Production needs a remote signer or KMS/HSM-backed signer, pinned binaries for any remaining CLI use, supply-chain verification, sandboxing, and independent security review.

## Hosted Secret Management

Docker Compose reads secrets from `.env`. That is acceptable for local testing, not real production.

Production needs:

- platform secret manager or KMS-backed injection
- least-privilege runtime identity
- secret access audit logs
- strict backup handling
- no secrets in images, logs, shell history, or compose files

## Safe for Demo

Reasonable demo use:

- `CUSTODY_MODE=local_cli`
- small balances
- low hard cap
- local or single-instance deployment
- test bot tokens
- controlled users
- no production customer funds

## Unsafe for Production Custody

Do not use this as real production custody until at least these are complete:

- remote signer or managed KMS/HSM-backed key management
- signer service threat model and security review
- Postgres or equivalent production database with migrations
- distributed locks tested across replicas
- secret rotation and incident response procedures
- immutable audit log shipping
- custody threat model reviewed by security and legal stakeholders
