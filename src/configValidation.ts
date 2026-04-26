import type { z } from "zod";
import { decodeMasterKey } from "./lib/crypto.js";

export interface ProductionConfigValues {
  NODE_ENV: "development" | "test" | "production";
  DATABASE_PROVIDER: "sqlite" | "postgres";
  ALLOW_SQLITE_IN_PRODUCTION: boolean;
  LOCK_PROVIDER: "local" | "redis";
  ALLOW_LOCAL_LOCKS_IN_PRODUCTION: boolean;
  CUSTODY_MODE: "local_cli" | "local_encrypted" | "remote_signer" | "kms";
  ALLOW_INSECURE_LOCAL_CUSTODY: boolean;
  BOT_MODE: "polling" | "webhook";
  WEBHOOK_SECRET_TOKEN?: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  ALLOW_VERBOSE_LOGS_IN_PRODUCTION: boolean;
  ALLOW_UNQUOTED_DEV_CALLS: boolean;
  SKIP_AGENTCASH_HEALTHCHECK: boolean;
  AGENTCASH_ARGS: string;
  HARD_SPEND_CAP_USDC: number;
  MASTER_ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  AUDIT_SINK: "database" | "file" | "http";
  AUDIT_STRICT_MODE: boolean;
  ALLOW_DATABASE_AUDIT_IN_PRODUCTION: boolean;
}

type RefinementContext = Pick<z.RefinementCtx, "addIssue">;

export function validateProductionConfig(
  values: ProductionConfigValues,
  ctx: RefinementContext,
  rawEnv: NodeJS.ProcessEnv
): void {
  if (values.NODE_ENV !== "production") {
    return;
  }

  addIssueIf(ctx, values.DATABASE_PROVIDER !== "postgres" && !values.ALLOW_SQLITE_IN_PRODUCTION, {
    message: "NODE_ENV=production requires DATABASE_PROVIDER=postgres",
    path: ["DATABASE_PROVIDER"]
  });

  addIssueIf(ctx, values.LOCK_PROVIDER !== "redis" && !values.ALLOW_LOCAL_LOCKS_IN_PRODUCTION, {
    message: "NODE_ENV=production requires LOCK_PROVIDER=redis",
    path: ["LOCK_PROVIDER"]
  });

  addIssueIf(ctx, values.CUSTODY_MODE === "local_cli" && !values.ALLOW_INSECURE_LOCAL_CUSTODY, {
    message:
      "CUSTODY_MODE=local_cli is demo-only and cannot run in production unless ALLOW_INSECURE_LOCAL_CUSTODY=true",
    path: ["CUSTODY_MODE"]
  });

  addIssueIf(ctx, values.CUSTODY_MODE === "local_encrypted", {
    message: "CUSTODY_MODE=local_encrypted is not production-intended; use remote_signer or kms",
    path: ["CUSTODY_MODE"]
  });

  addIssueIf(ctx, values.BOT_MODE === "webhook" && !values.WEBHOOK_SECRET_TOKEN, {
    message: "WEBHOOK_SECRET_TOKEN is required for production Telegram webhook mode",
    path: ["WEBHOOK_SECRET_TOKEN"]
  });

  addIssueIf(ctx, !isStrongProductionMasterKey(values.MASTER_ENCRYPTION_KEY), {
    message: "MASTER_ENCRYPTION_KEY must be a strong non-default 32-byte base64 secret in production",
    path: ["MASTER_ENCRYPTION_KEY"]
  });

  addIssueIf(
    ctx,
    (values.LOG_LEVEL === "trace" || values.LOG_LEVEL === "debug") &&
      !values.ALLOW_VERBOSE_LOGS_IN_PRODUCTION,
    {
      message: "LOG_LEVEL cannot be trace/debug in production unless ALLOW_VERBOSE_LOGS_IN_PRODUCTION=true",
      path: ["LOG_LEVEL"]
    }
  );

  addIssueIf(ctx, values.ALLOW_UNQUOTED_DEV_CALLS, {
    message: "ALLOW_UNQUOTED_DEV_CALLS must be false in production",
    path: ["ALLOW_UNQUOTED_DEV_CALLS"]
  });

  addIssueIf(ctx, values.SKIP_AGENTCASH_HEALTHCHECK, {
    message: "SKIP_AGENTCASH_HEALTHCHECK must be false in production",
    path: ["SKIP_AGENTCASH_HEALTHCHECK"]
  });

  addIssueIf(ctx, rawEnv.AGENTCASH_ARGS === undefined || rawEnv.AGENTCASH_ARGS === "", {
    message: "AGENTCASH_ARGS must be explicitly set in production",
    path: ["AGENTCASH_ARGS"]
  });

  addIssueIf(ctx, values.AGENTCASH_ARGS.includes("@latest"), {
    message: "AGENTCASH_ARGS must pin a tested AgentCash CLI version in production",
    path: ["AGENTCASH_ARGS"]
  });

  addIssueIf(ctx, rawEnv.HARD_SPEND_CAP_USDC === undefined || rawEnv.HARD_SPEND_CAP_USDC === "", {
    message: "HARD_SPEND_CAP_USDC must be explicitly set in production",
    path: ["HARD_SPEND_CAP_USDC"]
  });

  addIssueIf(ctx, !values.TELEGRAM_BOT_TOKEN && !values.DISCORD_BOT_TOKEN, {
    message: "At least one platform token is required in production",
    path: ["TELEGRAM_BOT_TOKEN"]
  });

  addIssueIf(ctx, values.AUDIT_SINK === "database" && !values.ALLOW_DATABASE_AUDIT_IN_PRODUCTION, {
    message: "Production requires AUDIT_SINK=file or http unless ALLOW_DATABASE_AUDIT_IN_PRODUCTION=true",
    path: ["AUDIT_SINK"]
  });
}

function isStrongProductionMasterKey(value: string): boolean {
  if (value === "replace-with-32-byte-base64-key") {
    return false;
  }

  return decodeMasterKey(value).length === 32;
}

function addIssueIf(
  ctx: RefinementContext,
  condition: boolean,
  input: { message: string; path: string[] }
) {
  if (!condition) {
    return;
  }

  ctx.addIssue({
    code: "custom",
    message: input.message,
    path: input.path
  });
}
