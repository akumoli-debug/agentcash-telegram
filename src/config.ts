import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "./lib/errors.js";
import { decodeMasterKey } from "./lib/crypto.js";

loadDotEnv();

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    DATABASE_PATH: z.string().default(".data/agentcash-telegram.db"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
    WEBHOOK_DOMAIN: z.string().trim().optional(),
    WEBHOOK_PATH: z.string().default("/telegram/webhook"),
    WEBHOOK_HOST: z.string().default("0.0.0.0"),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_SECRET_TOKEN: z.string().trim().optional(),
    AGENTCASH_COMMAND: z.string().default("npx"),
    AGENTCASH_ARGS: z.string().default("agentcash@latest"),
    AGENTCASH_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    DEFAULT_SPEND_CAP_USDC: z.coerce.number().positive().default(0.5),
    HARD_SPEND_CAP_USDC: z.coerce.number().positive().default(5),
    ALLOW_HIGH_VALUE_CALLS: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    ALLOW_UNQUOTED_DEV_CALLS: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    PENDING_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_MAX_PER_HOUR: z.coerce.number().int().positive().default(100),
    AGENTCASH_HOME_ROOT: z.string().default("data/agentcash-homes"),
    OPENAI_API_KEY: z.string().trim().optional(),
    OPENAI_ROUTER_MODEL: z.string().default("gpt-5.4-mini"),
    ANTHROPIC_API_KEY: z.string().trim().optional(),
    ANTHROPIC_ROUTER_MODEL: z.string().default("claude-sonnet-4-20250514"),
    ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    ROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    MASTER_ENCRYPTION_KEY: z
      .string()
      .min(1, "MASTER_ENCRYPTION_KEY is required")
      .refine(value => decodeMasterKey(value).length === 32, "MASTER_ENCRYPTION_KEY must decode to 32 bytes")
  })
  .superRefine((values, ctx) => {
    if (values.BOT_MODE === "webhook" && !values.WEBHOOK_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WEBHOOK_DOMAIN is required when BOT_MODE=webhook",
        path: ["WEBHOOK_DOMAIN"]
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  agentcashArgs: string[];
};

export function getConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new ConfigError("Invalid environment configuration", parsed.error.flatten());
  }

  const values = parsed.data;

  return {
    ...values,
    agentcashArgs: values.AGENTCASH_ARGS.split(" ").map(part => part.trim()).filter(Boolean)
  };
}
