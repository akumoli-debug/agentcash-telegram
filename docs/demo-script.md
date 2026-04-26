# Demo Script

This script is designed for a v0.1 evaluator demo. It should position the repo as an AgentCash/x402 spend-control layer, not as "AgentCash in Telegram" or a generic agent framework. Be honest about what is live, what is dry-run verified, and what is not production custody.

## Commands To Prepare

```bash
corepack pnpm install
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:dry
corepack pnpm release:check
```

For live smoke:

```bash
corepack pnpm smoke:agentcash
corepack pnpm smoke:live -- --no-funds
corepack pnpm dev
```

## 60-Second Version

Say:

> agentcash-telegram is a chat-native spend-control layer for AgentCash/x402 calls. It lets users and teams fund wallets, quote every paid call, enforce policies, approve risky spend, and audit usage across Telegram and Discord.

> This is not trying to be Hermes. Hermes is a broad agent gateway, and AgentCash as a Hermes skill proves there is demand for paid AgentCash actions in agent surfaces. This repo goes narrower and deeper on payments UX: wallet scopes, quote ledger, policy engine, approvals, audit, and spend analytics.

> It is also not trying to be CoWork-OS. CoWork-OS is a broad personal AI OS with wallet and x402 features. This repo focuses specifically on AgentCash spend governance.

Show:

1. README "Competitive Context", "Why This Exists", feature status table, and "Not Production Custody" section.
2. `corepack pnpm smoke:dry` output.
3. Telegram private chat:

```text
/start
/deposit
/balance
/cap 0.25
/policy
/policy dailycap 5.00
/research latest x402 ecosystem activity
/spend
/history
```

Say:

> The stable MVP surface is Telegram private wallets. Group wallets, inline mode, and Discord are implemented and tested, but labeled experimental until live smoke evidence is captured.

## 90-Second Version

Start with the 60-second flow, then show the spend-control loop:

1. Open [docs/diagrams/quote_flow.mmd](diagrams/quote_flow.mmd).
2. Explain that every paid call creates a quote ledger entry with the canonical request and policy snapshot.
3. Show a policy-triggered approval callback before execution.
4. Press the same approval button again and show replay rejection.
5. Show `/spend` and `/history` as user-facing spend analytics.
6. Point to audit export support in `audit_events` and the optional file/HTTP audit sink.
7. Run:

```bash
corepack pnpm test
corepack pnpm smoke:dry
```

Say:

> The important part is not that chat can call AgentCash. Hermes and CoWork-OS already prove multi-channel agent surfaces are becoming table stakes. The important part here is the missing payments layer: AgentCash/x402 spend is quoted, policy-checked, approval-gated, replay-resistant, and auditable.

Do not say:

- "This is AgentCash in Telegram."
- "This is a larger agent OS."
- "This competes by supporting more channels than Hermes."
- "Production custody is solved."
- "Postgres production is complete."
- "This is safe for unattended real-funds usage."

## Spend-Control Demo Beats

Quote:

```text
/research latest x402 ecosystem activity
```

Say:

> The bot asks AgentCash for a quote first and stores the canonical request. Execution uses the stored quote row, not whatever text appears later in chat.

Approval:

```text
/cap 0.25
/policy dailycap 5.00
/research latest x402 ecosystem activity
```

Say:

> The policy engine decides allow, deny, or approval-required before execution. Risky or first-spend paths require an approval callback.

Replay:

```text
Press the same approval button twice.
```

Say:

> The second click is rejected by quote status transitions, so the same quote cannot be consumed twice.

Spend analytics:

```text
/spend
/spend skills
/history
```

Say:

> Spend review is built around wallet scope, quote records, policy decisions, transactions, and audit events. This is the product wedge: payment governance for AgentCash/x402 calls.

Audit export:

```bash
sed -n '1,220p' docs/audit.md
```

Say:

> Audit events can stay in the local database or ship sanitized copies to a file or HTTP sink. That is audit export plumbing, not a claim of production custody.

## 3-Minute Technical Version

1. Show the architecture diagram:

```bash
sed -n '1,220p' docs/diagrams/architecture.mmd
```

2. Show the quote flow:

```bash
sed -n '1,220p' docs/diagrams/quote_flow.mmd
```

3. Show custody boundary:

```bash
sed -n '1,220p' docs/custody-review.md
sed -n '1,220p' src/custody/signer.ts
```

4. Show operational readiness:

```bash
sed -n '1,220p' docs/readiness.md
sed -n '1,220p' docs/deployment.md
```

5. Run:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke:dry
corepack pnpm release:check
```

Say:

> This is intentionally not called production custody. The v0.1 release proves the spend-control product shape and gives clear boundaries for future storage, distributed locking, and signer work.

## Exact Telegram Messages

Private wallet:

```text
/start
/deposit
/balance
/cap 0.25
/policy
/policy dailycap 5.00
/policy weeklycap 20.00
/research latest x402 ecosystem activity
/spend
/spend skills
/history
/freeze
/status
/unfreeze
```

Group wallet, from a Telegram group creator/admin:

```text
/groupwallet create
/groupwallet sync-admins
/groupwallet roles
/groupwallet balance
/groupwallet spend
/groupwallet spend skills
/groupwallet cap 0.25
/groupwallet history
```

Group wallet negative checks:

```text
/groupwallet create
/groupwallet cap 0.25
```

Run those from a non-admin account and confirm they are refused.

Inline mode, if enabled in BotFather:

```text
@<bot username> research latest x402 ecosystem activity
```

Verify the inline result is only a preview and does not execute a paid call until opened and confirmed.

## Exact Discord Commands

DM/user wallet:

```text
/ac wallet balance
/ac wallet deposit
/ac wallet cap amount:0.25
/ac spend today
/ac spend week
/ac wallet research query:latest x402 ecosystem activity
/ac wallet history
/ac wallet freeze
/ac wallet status
/ac wallet unfreeze
```

Guild wallet, from a member with Manage Server or Administrator:

```text
/ac guild create
/ac guild sync-admins
/ac guild balance
/ac guild deposit
/ac guild cap amount:0.25
/ac guild spend
/ac guild research query:latest x402 ecosystem activity
/ac guild history
/ac guild freeze
/ac guild status
/ac guild unfreeze
```

Guild negative check:

```text
/ac guild create
```

Run it from a member without Manage Server or Administrator and confirm it is refused.

## If AgentCash CLI Fails

Say:

> This demo depends on the local AgentCash CLI for live quote and execution. The dry-run harness proves the app wiring without credentials or funds. The CLI failure means we should not claim a live paid-call pass for this run.

Then show:

```bash
corepack pnpm smoke:dry
corepack pnpm test
```

Record the failure in the live smoke notes with the exact command, timestamp, commit SHA, and error message.

## Custody Limitation Talk Track

Say:

> This repo is not production custody. The local CLI path is demo-only. The code has a signer boundary so future remote signer or KMS work does not require passing raw keys through product code, but that production signer is not implemented or reviewed here.

Do not say:

- "production custody is solved"
- "KMS is integrated"
- "Postgres production is complete"
- "Redis locking makes duplicate spend impossible"
- "This is safe for unattended real-funds usage"

## Evidence To Capture

- Commit SHA.
- Date and environment.
- `corepack pnpm test` result.
- `corepack pnpm smoke:dry` result.
- Whether `corepack pnpm smoke:agentcash` passed.
- Telegram private live smoke result.
- Telegram group live smoke result.
- Discord DM live smoke result.
- Discord guild live smoke result.
- Whether real funds were used.
