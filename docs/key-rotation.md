# Key Rotation

This document is intentionally conservative. Local demo key rotation exists to create an audit trail and avoid overwriting old keys. It is not a production fund migration system.

## Current Tables

- `key_versions`: one row per wallet key version, with `active` or `deprecated` status.
- `wallet_keys`: encrypted local key material for local/demo modes.
- `wallets.active_key_version`: the version currently used by the wallet row.

`key_rotated` audit events record the old and new version numbers and mark fund migration as required.

## Local Demo Rotation

The local rotation path:

1. Keeps the old encrypted key.
2. Marks the prior key version deprecated.
3. Stores the new encrypted key as the active version.
4. Updates the wallet address/public address metadata when provided.
5. Writes a `key_rotated` audit event.

It does not:

- transfer funds
- prove the old wallet has zero balance
- destroy old key material
- rotate `MASTER_ENCRYPTION_KEY`
- work as a production custody control

## Required Manual Fund Migration

Before considering an old key inactive in a real demo:

1. Check the old wallet balance.
2. Create or provision the new wallet/key.
3. Transfer funds from the old wallet to the new wallet using an operator-controlled process.
4. Confirm the old wallet has no funds.
5. Keep the old key available long enough for refunds, stuck payments, or chain reconciliation.
6. Record the operator action outside the app until immutable audit shipping exists.

## Production Rotation Requirements

Production-ready custody needs:

- remote signer or KMS/HSM key hierarchy
- key creation, activation, deprecation, and disable states
- dual-read or versioned signing during migration
- automated balance and transfer reconciliation
- immutable external audit logs
- rollback plan
- incident-response runbook
- tested rotation drills

Until that exists, key rotation is demo bookkeeping, not a final-product custody guarantee.
