# Suspicious Spend

## Symptoms

- Unexpected `transaction_recorded` or `quote_execution_succeeded` audit events.
- Repeated replay attempts or unusual paid-call volume.
- Wallet balance lower than expected.

## Immediate Mitigation

- Freeze the affected wallet with `/freeze`, `/groupwallet` admin controls, or Discord wallet/guild freeze.
- Lower `HARD_SPEND_CAP_USDC`.
- Disable natural-language routed paid calls if abuse is text-driven.

## Commands / Env Changes

```bash
ALLOW_HIGH_VALUE_CALLS=false
ALLOW_UNQUOTED_DEV_CALLS=false
HARD_SPEND_CAP_USDC=0.01
```

## Data To Preserve

- `audit_events`
- `quotes`
- `transactions`
- `preflight_attempts`
- Platform update logs

## Recovery

- Review quotes and request hashes.
- Confirm whether spend came from expected users/admins.
- Rotate exposed keys if custody compromise is possible.

## Postmortem Notes

- Identify missing alert or approval control.
- Decide whether per-wallet or group daily caps need tightening.
