import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        "privateKey",
        "encryptedPrivateKey",
        "X402_PRIVATE_KEY",
        "*.privateKey",
        "*.encryptedPrivateKey",
        "*.X402_PRIVATE_KEY",
        "encryptedInput",
        "*.encryptedInput",
        "state_json",
        "*.state_json",
        "req.headers.authorization",
        "req.headers.x-api-key",
        "headers.authorization",
        "headers.x-api-key",
        "telegram.username",
        "telegram.firstName",
        "telegram.lastName",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "WEBHOOK_SECRET_TOKEN",
        "stdout",
        "stderr",
        "raw",
        "*.raw"
      ],
      censor: "[REDACTED]"
    },
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard"
            }
          }
        : undefined
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
