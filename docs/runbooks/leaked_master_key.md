# Leaked Master Key

## Symptoms

- `MASTER_ENCRYPTION_KEY` appears in logs, shell history, screenshots, or CI output.
- Host or secret manager compromise includes app env vars.

## Immediate Mitigation

- Treat all local encrypted wallet keys as potentially exposed.
- Freeze affected wallets where possible.
- Stop paid execution until wallet balances and key exposure are understood.

## Commands / Env Changes

```bash
ALLOW_HIGH_VALUE_CALLS=false
HARD_SPEND_CAP_USDC=0.01
docker compose up -d --build
```

Do not simply rotate `MASTER_ENCRYPTION_KEY`; existing encrypted wallet records cannot be read without a migration plan.

## Data To Preserve

- Current database backup.
- Audit events and transaction history.
- Host access logs and secret manager access logs.

## Recovery

- Create new wallets/keys.
- Move funds manually after confirming destination ownership.
- Keep old encrypted keys until old balances are zero and reconciliation is complete.

## Postmortem Notes

- Record exposure window.
- Identify all wallets created during exposure.
- Add controls to prevent env leakage.
