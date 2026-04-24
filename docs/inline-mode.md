# Inline Mode

Telegram inline mode is preview-first. Inline results never execute paid calls.

## Setup

Enable inline mode with BotFather:

```text
/setinline
```

Set `TELEGRAM_BOT_USERNAME` if you want each preview card to include a direct deep-link button:

```bash
TELEGRAM_BOT_USERNAME=your_bot_name
```

Without `TELEGRAM_BOT_USERNAME`, Telegram still receives an inline answer button with the signed start parameter.

## Supported Queries

Type these in any Telegram chat after the bot username:

```text
@your_bot research latest x402 ecosystem activity
@your_bot enrich jane@example.com
@your_bot generate neon wallet icon
```

Empty or ambiguous inline queries return a help card only.

## Safety Model

Inline mode creates an `InlineQueryResultArticle` preview card with:

- a short title and summary
- the description `Estimate and confirm before spending`
- message content that does not contain the raw signed payload
- a deep link or Telegram inline answer button that opens the bot

The deep link carries a short signed token. The actual payload is stored server-side with:

- skill
- sanitized input
- timestamp
- nonce
- HMAC signature using `MASTER_ENCRYPTION_KEY`
- 5 minute expiry

When `/start <token>` is received, the bot verifies and consumes the payload, then calls the normal `executeSkillRequest` path with `forceConfirmation=true`. That means inline mode still creates a quote, checks balance and caps, and requires confirmation before any spend.

## Limitations

- Telegram `/start` parameters are short, so the deep link contains a signed token rather than the full request payload.
- Inline payloads are single-use and expire after 5 minutes.
- `enrich` previews accept email/domain/person text, but the current paid enrichment endpoint may still reject inputs it cannot safely validate.
