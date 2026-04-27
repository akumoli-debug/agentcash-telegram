# Recon

## Repos inspected

- `agentcash-skills`
- `agentcash-gtm-agent`
- `ambient-agent`
- `x402scan-mcp`

## Key findings

### AgentCash invocation

The most stable integration surface across the Merit repos is the AgentCash CLI boundary, not a polished public TypeScript SDK.

Useful CLI patterns:

- `npx agentcash@0.14.3 accounts`
- `npx agentcash@0.14.3 balance`
- `npx agentcash@0.14.3 check <endpoint>`
- `npx agentcash@0.14.3 fetch <endpoint>`

That matches the implementation here: the bot shells out to AgentCash in isolated per-user homes and keeps payment control at the app layer.

### TypeScript API vs CLI/MCP

The inspected repos pointed more strongly to CLI and MCP usage than to a reusable application-facing TS client.

- `x402scan-mcp` was the clearest reference for wallet, check, and fetch flows.
- `agentcash-skills` was the clearest reference for deterministic endpoint selection and skill structure.
- `ambient-agent` was useful for application organization and per-user state ideas.
- `agentcash-gtm-agent` helped with product framing more than with runtime integration details.

### Skill structure

For the MVP, the cleanest path was deterministic command-to-endpoint mapping:

- `research` -> stable web research endpoint
- `enrich` -> stable person/company enrichment endpoint
- `generate` -> stable image generation endpoint

This avoids premature natural-language orchestration in the paid execution path.

### Wallet and payment handling

The recon suggested:

- wallet funding should stay outside the Telegram app’s own custody logic
- the bot should provision or load an AgentCash wallet per Telegram user
- paid calls should run through `check` and `fetch`
- application-side spending caps should be enforced before the paid request

## Recommended integration approach

- Use TypeScript with Node 22 LTS
- Use AgentCash via CLI subprocess calls
- Isolate each Telegram user under `data/agentcash-homes/<telegram_id_hash>/`
- Store only safe wallet metadata in SQLite
- Encrypt any persisted wallet secret material with `MASTER_ENCRYPTION_KEY`
- Route all paid execution through one shared `skillExecutor`

## Risks

- Upstream AgentCash CLI output may change
- SQLite is good for demo and contributor workflows, not distributed production
- Wallet secret handling is acceptable for a local MVP but should move to managed secret infrastructure before hosted deployment
- Router usage adds third-party LLM exposure for freeform messages when enabled

## Exact files and functions used in this repo

- `src/agentcash/agentcashClient.ts`
  - `ensureWallet`
  - `getBalance`
  - `getDepositInfo`
  - `checkEndpoint`
  - `fetchJson`
  - `pollJob`
- `src/wallets/walletManager.ts`
  - `getOrCreateWalletForTelegramUser`
  - `getBalance`
  - `getDepositAddress`
- `src/agentcash/skillExecutor.ts`
  - `execute`
  - `decryptPendingInput`

## MVP scope for 3 days

- `/start`
- `/balance`
- `/deposit`
- `/research`
- `/enrich`
- `/generate`
- per-user wallet isolation
- spending caps
- confirmation flow
- transaction logging
- README and demo flow

## Not in scope yet

- group wallets
- shared team balances
- broad natural-language orchestration
- plugin marketplace packaging
- hosted multi-tenant deployment
