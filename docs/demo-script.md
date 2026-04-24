# Demo Script

## Goal

Show the smallest useful AgentCash Telegram loop:

1. fund once
2. call paid APIs from chat
3. keep spend controls explicit

## Before the demo

- start the bot locally with `corepack pnpm dev`
- fund a demo wallet or be ready to show the deposit flow
- have Telegram open on desktop or mobile

## Script

### 1. Start

Send:

```text
/start
```

What to say:

- this provisions or loads a wallet for this Telegram user only
- the deposit address comes back immediately

Placeholder capture:

- `docs/assets/start.png`

### 2. Deposit

Send:

```text
/deposit
```

What to say:

- this shows the wallet funding QR and deposit link
- the wallet is isolated per Telegram user

Placeholder capture:

- `docs/assets/deposit.png`

### 3. Balance

Send:

```text
/balance
```

What to say:

- this checks the AgentCash wallet balance
- it also shows the active spend cap state

Placeholder capture:

- `docs/assets/balance.png`

### 4. Research

Send:

```text
/research latest x402 ecosystem activity
```

What to say:

- the bot estimates cost, checks balance, and uses the shared paid execution pipeline
- calls above the cap require confirmation

Placeholder capture:

- `docs/assets/research.png`

### 5. Enrich

Send:

```text
/enrich jane@example.com
```

What to say:

- this uses the deterministic enrichment endpoint
- the bot returns concise fields rather than dumping raw provider output

Placeholder capture:

- `docs/assets/enrich.png`

### 6. Generate

Send:

```text
/generate lobster wearing a tuxedo
```

What to say:

- image generation uses the same wallet, cap, and confirmation controls
- if the upstream API returns an image URL, the bot sends the image back into Telegram

Placeholder capture:

- `docs/assets/generate.png`
- `docs/assets/demo.gif`

## Optional natural language demo

If `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is configured, send:

```text
make an image of a lobster in a tuxedo
```

What to say:

- natural language routing is optional
- it never auto-pays without showing confirmation first
