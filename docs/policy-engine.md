# Payment Policy Engine

The policy engine evaluates every incoming payment request before a quote is created. It enforces spending limits, skill access controls, and confirmation requirements across all platforms (Telegram, Discord).

## Architecture

`PolicyEngine` is a synchronous evaluator in `src/policy/PolicyEngine.ts`. It receives a `PolicyEvaluationInput`, queries the database for per-wallet policy overrides, and returns a `PolicyDecision` containing:
- **outcome** — what to do with the request
- **policyType** — which rule fired
- **reason** — human-readable explanation
- **requiresGroupAdminApproval** — whether a group admin must confirm
- **capStatusText** — formatted cap usage string (for deny messages)
- **snapshotJson** — immutable JSON copy of all policy parameters at decision time

The snapshot is stored in `policy_decisions` with a foreign key to the quote. Changing policies after a quote is issued never modifies historical records.

## Policy Evaluation Order

| Step | Policy | Outcome |
|------|--------|---------|
| 1 | Unknown platform | `deny_platform` |
| 2 | Wallet frozen | `deny_frozen` |
| 3 | Skill not in per-wallet allowlist | `deny_skill_blocked` |
| 4 | Skill explicitly blocked | `deny_skill_blocked` |
| 5 | Daily wallet cap exceeded | `deny_daily_cap` |
| 6 | Weekly wallet cap exceeded | `deny_weekly_cap` |
| 7 | Group daily cap exceeded | `deny_daily_cap` |
| 8 | Hard spend cap exceeded | `deny_hard_cap` |
| 9 | Trusted skill below auto-approve threshold | `allow` |
| 10 | First spend (if opt-in enabled) | `require_confirmation` |
| 11a | Group quote over group admin threshold | `require_group_admin_approval` |
| 11b | Cost over per-call confirmation cap | `require_confirmation` |
| 12 | High-cost threshold | `require_confirmation` |
| — | Default | `allow` |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `POLICY_DAILY_CAP_USDC` | _(disabled)_ | Per-user wallet daily spend cap in USDC |
| `POLICY_WEEKLY_CAP_USDC` | _(disabled)_ | Per-user wallet weekly spend cap in USDC |
| `POLICY_HIGH_COST_THRESHOLD_USDC` | _(disabled)_ | Above this cost (USDC), confirmation is always required |
| `POLICY_TRUSTED_SKILLS` | `""` | Comma-separated skill names eligible for auto-approve |
| `POLICY_TRUSTED_AUTO_APPROVE_MAX_USDC` | `0.01` | Max cost for trusted-skill auto-approve to fire |
| `POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION` | `false` | Require confirmation for the very first spend from a wallet |

Per-call confirmation caps and group caps are set via the existing `/cap` and `/groupwallet cap` commands (stored in the `users` and `groups` tables respectively).

## Database Tables

### `wallet_policies`
Per-wallet spending limits and skill allowlists. Rows are optional — a missing row means "use global config defaults".

| Column | Type | Description |
|--------|------|-------------|
| `wallet_id` | TEXT | FK to `wallets.id` (unique) |
| `daily_cap_usdc` | REAL | Daily cap override; NULL = use global |
| `weekly_cap_usdc` | REAL | Weekly cap override; NULL = none |
| `skill_allowlist` | TEXT | Comma-separated allowed skills; NULL = all |

### `skill_policies`
Per-wallet, per-skill status overrides.

| Column | Type | Values |
|--------|------|--------|
| `skill` | TEXT | `research`, `enrich`, `generate` |
| `status` | TEXT | `allowed` \| `trusted` \| `blocked` |

`trusted` — skill is auto-approved below `POLICY_TRUSTED_AUTO_APPROVE_MAX_USDC`.
`blocked` — skill is always denied for this wallet.

### `policy_decisions`
Immutable audit record, one row per quote.

| Column | Type | Description |
|--------|------|-------------|
| `quote_id` | TEXT | FK to `quotes.id` (unique) |
| `outcome` | TEXT | The decision outcome |
| `policy_type` | TEXT | Which rule fired |
| `reason` | TEXT | Human-readable explanation |
| `snapshot_json` | TEXT | Full policy state at decision time |

## Commands

### Telegram (private chat)

| Command | Description |
|---------|-------------|
| `/policy` | Show current wallet policy (caps, skill overrides, status) |
| `/policy dailycap <amount\|off>` | Set or remove per-wallet daily cap |
| `/policy weeklycap <amount\|off>` | Set or remove per-wallet weekly cap |
| `/policy allow-skill <skill>` | Allow a specific skill |
| `/policy block-skill <skill>` | Block a specific skill |
| `/policy freeze` | Freeze your wallet |
| `/policy unfreeze` | Unfreeze your wallet |

### Telegram (group chat)

| Command | Description |
|---------|-------------|
| `/groupwallet policy` | Show group wallet policy |
| `/groupwallet dailycap <amount\|off>` | Set or remove group daily cap override |

### Discord

| Command | Description |
|---------|-------------|
| `/ac wallet policy` | Show user wallet policy |
| `/ac guild policy` | Show guild wallet policy |

## Integration with SkillExecutor

`PolicyEngine.evaluate()` is called in `SkillExecutor.execute()` after the quote cost is known but before the quote row is created. The outcome maps to:

- `deny_*` → throws `SpendingCapError` or `ValidationError` (logged to `preflight_attempts`)
- `require_confirmation` or `require_group_admin_approval` → returns `QuoteConfirmationResult`
- `allow` → quote is auto-approved and execution proceeds

The policy snapshot is stored in `policy_decisions` immediately after the quote is created, forming an immutable audit trail.

## Security Notes

- **Snapshot immutability**: policy_decisions rows are never updated. Changing policy rules after a quote is created does not affect the recorded decision.
- **Hard cap is always enforced**: `deny_hard_cap` fires even when `ALLOW_HIGH_VALUE_CALLS=false` (the default). Set `ALLOW_HIGH_VALUE_CALLS=true` only for testing.
- **Group daily cap**: applies to the group wallet regardless of individual user caps. Implemented in step 7 of the evaluation chain, replacing the former `assertGroupDailyCap` in SkillExecutor.
