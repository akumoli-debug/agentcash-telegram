import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "./lib/errors.js";
import { decodeMasterKey } from "./lib/crypto.js";
import { validateProductionConfig } from "./configValidation.js";

loadDotEnv();

const optionalString = z.preprocess(
  value => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional()
);
const optionalUrl = z.preprocess(
  value => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_BOT_USERNAME: optionalString,
    DISCORD_BOT_TOKEN: optionalString,
    DISCORD_APPLICATION_ID: optionalString,
    DISCORD_DEV_GUILD_ID: optionalString,
    DATABASE_PROVIDER: z.enum(["sqlite", "postgres"]).default("sqlite"),
    DATABASE_PATH: z.string().default(".data/agentcash-telegram.db"),
    DATABASE_URL: optionalString,
    ALLOW_SQLITE_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    LOCK_PROVIDER: z.enum(["local", "redis"]).default("local"),
    REDIS_URL: optionalString,
    ALLOW_LOCAL_LOCKS_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    AUDIT_SINK: z.enum(["database", "file", "http"]).default("database"),
    AUDIT_FILE_PATH: z.string().default(".data/audit-events.jsonl"),
    AUDIT_HTTP_ENDPOINT: optionalUrl,
    ALLOW_DATABASE_AUDIT_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    ALLOW_VERBOSE_LOGS_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
    WEBHOOK_DOMAIN: optionalString,
    WEBHOOK_PATH: z.string().default("/telegram/webhook"),
    WEBHOOK_HOST: z.string().default("0.0.0.0"),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_SECRET_TOKEN: optionalString,
    HEALTH_HOST: z.string().default("0.0.0.0"),
    HEALTH_PORT: z.coerce.number().int().min(0).default(3001),
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
    SKIP_AGENTCASH_HEALTHCHECK: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    CUSTODY_MODE: z
      .enum(["local_cli", "local_encrypted", "remote_signer", "kms"])
      .default("local_cli"),
    ALLOW_INSECURE_LOCAL_CUSTODY: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    REMOTE_SIGNER_URL: optionalUrl,
    PENDING_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_MAX_PER_HOUR: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_QUOTE_MAX_PER_MINUTE: z.coerce.number().int().positive().default(8),
    RATE_LIMIT_PAID_EXECUTION_MAX_PER_MINUTE: z.coerce.number().int().positive().default(3),
    RATE_LIMIT_REPLAY_MAX_PER_HOUR: z.coerce.number().int().positive().default(10),
    GLOBAL_PAID_CALL_CONCURRENCY: z.coerce.number().int().positive().default(4),
    GROUP_DAILY_CAP_USDC: z.coerce.number().positive().default(25),
    AGENTCASH_HOME_ROOT: z.string().default("data/agentcash-homes"),
    OPENAI_API_KEY: optionalString,
    OPENAI_ROUTER_MODEL: z.string().default("gpt-5.4-mini"),
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_ROUTER_MODEL: z.string().default("claude-sonnet-4-20250514"),
    ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    ROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    RESEARCH_WORKFLOW_DEMO_MODE: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("true")
      .transform(value => value === true || value === "true"),
    MASTER_ENCRYPTION_KEY: z
      .string()
      .min(1, "MASTER_ENCRYPTION_KEY is required")
      .refine(value => decodeMasterKey(value).length === 32, "MASTER_ENCRYPTION_KEY must decode to 32 bytes")
  })
  .superRefine((values, ctx) => {
    if (!values.TELEGRAM_BOT_TOKEN && !values.DISCORD_BOT_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one bot token is required: TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN",
        path: ["TELEGRAM_BOT_TOKEN"]
      });
    }

    if (values.DISCORD_BOT_TOKEN && !values.DISCORD_APPLICATION_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DISCORD_APPLICATION_ID is required when DISCORD_BOT_TOKEN is set",
        path: ["DISCORD_APPLICATION_ID"]
      });
    }

    if (values.DATABASE_PROVIDER === "postgres" && !values.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_URL is required when DATABASE_PROVIDER=postgres",
        path: ["DATABASE_URL"]
      });
    }

    if (values.LOCK_PROVIDER === "redis" && !values.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "REDIS_URL is required when LOCK_PROVIDER=redis",
        path: ["REDIS_URL"]
      });
    }

    if (values.BOT_MODE === "webhook" && !values.WEBHOOK_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WEBHOOK_DOMAIN is required when BOT_MODE=webhook",
        path: ["WEBHOOK_DOMAIN"]
      });
    }

    if (values.BOT_MODE === "webhook" && !values.WEBHOOK_SECRET_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WEBHOOK_SECRET_TOKEN is required when BOT_MODE=webhook",
        path: ["WEBHOOK_SECRET_TOKEN"]
      });
    }

    if (values.CUSTODY_MODE === "remote_signer" && !values.REMOTE_SIGNER_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "REMOTE_SIGNER_URL is required when CUSTODY_MODE=remote_signer",
        path: ["REMOTE_SIGNER_URL"]
      });
    }

    if (values.AUDIT_SINK === "http" && !values.AUDIT_HTTP_ENDPOINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AUDIT_HTTP_ENDPOINT is required when AUDIT_SINK=http",
        path: ["AUDIT_HTTP_ENDPOINT"]
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  agentcashArgs: string[];
};

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message;
    throw new ConfigError(
      firstIssue ? `Invalid environment configuration: ${firstIssue}` : "Invalid environment configuration",
      parsed.error.flatten()
    );
  }

  const values = parsed.data;
  validateParsedProductionConfig(values, env);

  return {
    ...values,
    agentcashArgs: values.AGENTCASH_ARGS.split(" ").map(part => part.trim()).filter(Boolean)
  };
}

function validateParsedProductionConfig(values: z.infer<typeof envSchema>, env: NodeJS.ProcessEnv) {
  const issues: z.ZodIssue[] = [];
  validateProductionConfig(
    values,
    {
      addIssue(issue) {
        issues.push(issue as z.ZodIssue);
      }
    },
    env
  );

  if (issues.length > 0) {
    throw new ConfigError(`Invalid environment configuration: ${issues[0]!.message}`, {
      formErrors: [],
      fieldErrors: Object.fromEntries(issues.map(issue => [issue.path.join("."), [issue.message]]))
    });
  }
}

export function getConfig(): AppConfig {
  return parseConfig(process.env);
}
