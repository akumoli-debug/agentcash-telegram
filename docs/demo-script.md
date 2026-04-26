# Demo Script

This script is designed for a v0.1 evaluator demo. It should be honest about what is live, what is dry-run verified, and what is not production-ready custody.

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

> agentcash-telegram is a chat-native spend-control layer for paid agent/API calls. The product idea is simple: fund once, quote every paid call, enforce caps, confirm risky spend, and keep an audit trail from chat.

Show:

1. README status table and the "not production-ready custody" section.
2. `corepack pnpm smoke:dry` output.
3. Telegram private chat:

```text
/start
/deposit
/balance
/cap 0.25
/research latest x402 ecosystem activity
/history
```

Say:

> The stable MVP surface is Telegram private wallets. Group wallets, inline mode, and Discord are implemented and tested, but labeled experimental until live smoke evidence is captured.

## 90-Second Version

Start with the 60-second flow, then add the safety model:

1. Open [docs/diagrams/quote_flow.mmd](diagrams/quote_flow.mmd).
2. Explain that paid execution uses stored quote records, not re-parsed chat text.
3. Show one confirmation and then replay the same button.
4. Show that the replay is rejected.
5. Run:

```bash
corepack pnpm test
corepack pnpm smoke:dry
```

Say:

> The important part is not that chat can call an API. The important part is that chat spend is quoted, capped, confirmed, and auditable.

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

> This is intentionally not called production custody. The v0.1 release proves the spend-control product shape and gives clear seams for production storage, distributed locking, and signer work.

## Exact Telegram Messages

Private wallet:

```text
/start
/deposit
/balance
/cap 0.25
/research latest x402 ecosystem activity
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

> This repo is not production-ready custody. The local CLI path is demo-only. The code now has a signer boundary so future remote signer or KMS work does not require passing raw keys through product code, but that production signer is not implemented or reviewed here.

Do not say:

- "production custody is solved"
- "KMS is integrated"
- "Postgres production is complete"
- "Redis locking makes duplicate spend impossible"

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
