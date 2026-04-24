import type { Context } from "telegraf";
import type { InlineQueryResultArticle } from "telegraf/types";
import type { SkillName } from "../agentcash/skillExecutor.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import { hashSensitiveValue } from "../lib/crypto.js";
import { createSignedInlinePayload } from "../lib/inlinePayload.js";
import type { AppLogger } from "../lib/logger.js";

export interface InlineIntent {
  type: "intent";
  skill: SkillName;
  input: string;
  summary: string;
}

export interface InlineHelpIntent {
  type: "help";
  reason: "empty" | "ambiguous";
}

export type ParsedInlineQuery = InlineIntent | InlineHelpIntent;

const inlineCommands: Record<string, SkillName> = {
  research: "research",
  enrich: "enrich",
  generate: "generate"
};

export function createInlineQueryHandler(deps: {
  config: AppConfig;
  db: AppDatabase;
  logger: AppLogger;
}) {
  return async (ctx: Context) => {
    const query = ctx.inlineQuery?.query ?? "";
    const parsed = parseInlineQuery(query);
    const results =
      parsed.type === "intent"
        ? [buildPreviewArticle(deps, parsed)]
        : [buildHelpArticle(parsed.reason)];
    const token = parsed.type === "intent" ? results[0]!.id.slice("preview_".length) : undefined;

    deps.logger.info(
      {
        inlineQueryHash: hashSensitiveValue(query, deps.config.MASTER_ENCRYPTION_KEY).slice(0, 24),
        intent: parsed.type === "intent" ? parsed.skill : parsed.reason
      },
      "answered inline query preview"
    );

    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: true,
      ...(token ? { button: { text: "Open bot to estimate and confirm", start_parameter: token } } : {})
    } as never);
  };
}

export function parseInlineQuery(raw: string): ParsedInlineQuery {
  const trimmed = sanitizeInlineInput(raw);
  if (!trimmed) {
    return { type: "help", reason: "empty" };
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { type: "help", reason: "ambiguous" };
  }

  const command = trimmed.slice(0, firstSpace).toLowerCase();
  const skill = inlineCommands[command];
  const input = sanitizeInlineInput(trimmed.slice(firstSpace + 1));

  if (!skill || input.length < 3) {
    return { type: "help", reason: "ambiguous" };
  }

  return {
    type: "intent",
    skill,
    input,
    summary: summarize(input)
  };
}

export function buildPreviewArticle(
  deps: { config: AppConfig; db: AppDatabase },
  intent: InlineIntent
): InlineQueryResultArticle {
  const { token } = createSignedInlinePayload(deps.db, deps.config.MASTER_ENCRYPTION_KEY, {
    skill: intent.skill,
    sanitizedInput: intent.input
  });
  const title = `${capitalize(intent.skill)}: ${intent.summary}`;
  const botUsername = deps.config.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const url = botUsername ? `https://t.me/${botUsername}?start=${token}` : undefined;

  return {
    type: "article",
    id: `preview_${token}`,
    title,
    description: "Estimate and confirm before spending",
    input_message_content: {
      message_text: `Preview selected for ${intent.skill}. Open the bot to estimate and confirm before spending.`
    },
    ...(url
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Estimate and confirm", url }]]
          }
        }
      : {})
  };
}

export function buildHelpArticle(reason: InlineHelpIntent["reason"]): InlineQueryResultArticle {
  const text =
    reason === "empty"
      ? "Examples: research x402 adoption, enrich jane@example.com, generate neon wallet icon"
      : "Use research <query>, enrich <email/domain/person>, or generate <prompt>.";

  return {
    type: "article",
    id: `help_${reason}`,
    title: "AgentCash inline mode",
    description: "Preview only. No paid call runs from inline results.",
    input_message_content: {
      message_text: text
    }
  };
}

function sanitizeInlineInput(input: string): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function summarize(input: string): string {
  return input.length > 48 ? `${input.slice(0, 45)}...` : input;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
