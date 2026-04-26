import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "./lib/errors.js";
import { decodeMasterKey } from "./lib/crypto.js";
import { validateProductionConfig } from "./configValidation.js";

loadDotEnv();

export const TESTED_AGENTCASH_PACKAGE = "agentcash@0.14.3";

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
    TELEGRAM_BOT_USERNAME: z.string().trim().optional(),
    DISCORD_BOT_TOKEN: z.string().trim().optional(),
    DISCORD_APPLICATION_ID: z.string().trim().optional(),
    DISCORD_DEV_GUILD_ID: z.string().trim().optional(),
    DATABASE_PROVIDER: z.enum(["sqlite", "postgres"]).default("sqlite"),
    DATABASE_PATH: z.string().default(".data/agentcash-telegram.db"),
    DATABASE_URL: z.string().trim().optional(),
    ALLOW_SQLITE_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    LOCK_PROVIDER: z.enum(["local", "redis"]).default("local"),
    REDIS_URL: z.string().trim().optional(),
    ALLOW_LOCAL_LOCKS_IN_PRODUCTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    AUDIT_SINK: z.enum(["database", "file", "http"]).default("database"),
    AUDIT_STRICT_MODE: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    AUDIT_FILE_PATH: z.string().default(".data/audit-events.jsonl"),
    AUDIT_HTTP_ENDPOINT: z.string().url().optional(),
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
    WEBHOOK_DOMAIN: z.string().trim().optional(),
    WEBHOOK_PATH: z.string().default("/telegram/webhook"),
    WEBHOOK_HOST: z.string().default("0.0.0.0"),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_SECRET_TOKEN: z.string().trim().optional(),
    HEALTH_HOST: z.string().default("0.0.0.0"),
    HEALTH_PORT: z.coerce.number().int().min(0).default(3001),
    AGENTCASH_COMMAND: z.string().default("npx"),
    AGENTCASH_ARGS: z.string().default(TESTED_AGENTCASH_PACKAGE),
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
    REMOTE_SIGNER_URL: z.string().url().optional(),
    PENDING_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // Gateway security: allowlists, pairing, group-mention requirements.
    // Raw platform user IDs (comma-separated). Hashed at startup using the master key.
    GATEWAY_ALLOWED_USERS: z.string().default(""),
    TELEGRAM_ALLOWED_USERS: z.string().default(""),
    DISCORD_ALLOWED_USERS: z.string().default(""),
    GATEWAY_ALLOW_ALL_USERS: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    PAIRING_MODE: z.enum(["disabled", "dm_code"]).default("disabled"),
    PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // When true, plain group text messages require a bot @mention before routing.
    TELEGRAM_GROUP_REQUIRE_MENTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("true")
      .transform(value => value === true || value === "true"),
    // Slash commands always pass. Natural language in guilds requires @mention by default.
    DISCORD_GUILD_REQUIRE_MENTION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("true")
      .transform(value => value === true || value === "true"),
    // Comma-separated hashed chat IDs that bypass the require-mention rule.
    GROUP_FREE_RESPONSE_CHAT_IDS: z.string().default(""),
    // Payment policy engine: per-wallet caps, trusted skills, first-spend confirmation.
    // Daily and weekly caps are per-wallet (users). Group daily cap uses GROUP_DAILY_CAP_USDC.
    POLICY_DAILY_CAP_USDC: z.optional(z.coerce.number().positive()),
    POLICY_WEEKLY_CAP_USDC: z.optional(z.coerce.number().positive()),
    // Above this threshold a confirmation is always required (independent of per-call cap).
    POLICY_HIGH_COST_THRESHOLD_USDC: z.optional(z.coerce.number().positive()),
    // Comma-separated skill names that are auto-approved without confirmation when cost is low.
    POLICY_TRUSTED_SKILLS: z.string().default(""),
    // Maximum cost in USDC for a trusted-skill auto-approval to fire.
    POLICY_TRUSTED_AUTO_APPROVE_MAX_USDC: z.coerce.number().positive().default(0.01),
    // Require confirmation for the very first spend from a wallet (default false to preserve existing behavior).
    POLICY_FIRST_SPEND_REQUIRE_CONFIRMATION: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .default("false")
      .transform(value => value === true || value === "true"),
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_MAX_PER_HOUR: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_QUOTE_MAX_PER_MINUTE: z.coerce.number().int().positive().default(8),
    RATE_LIMIT_PAID_EXECUTION_MAX_PER_MINUTE: z.coerce.number().int().positive().default(3),
    RATE_LIMIT_REPLAY_MAX_PER_HOUR: z.coerce.number().int().positive().default(10),
    GLOBAL_PAID_CALL_CONCURRENCY: z.coerce.number().int().positive().default(4),
    GROUP_DAILY_CAP_USDC: z.coerce.number().positive().default(25),
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
  warnOnLatestAgentCashInDevelopment(values);

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

function warnOnLatestAgentCashInDevelopment(values: z.infer<typeof envSchema>): void {
  if (values.NODE_ENV !== "development" || !values.AGENTCASH_ARGS.includes("@latest")) {
    return;
  }

  console.warn(
    "AGENTCASH_ARGS contains @latest. This is allowed only for development experiments; pin a tested AgentCash CLI version before demo or release."
  );
}

export function getConfig(): AppConfig {
  return parseConfig(process.env);
}
