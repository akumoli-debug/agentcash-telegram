import { z } from "zod";
import type { AppConfig } from "../config.js";
import { hashSensitiveValue } from "../lib/crypto.js";
import type { AppLogger } from "../lib/logger.js";
import { ROUTER_PROMPT } from "./prompt.js";

const routerDecisionSchema = z.object({
  skill: z.enum(["research", "enrich", "generate", "none"]),
  args: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1)
});

export type RouterDecision = z.infer<typeof routerDecisionSchema>;

export class RouterClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.OPENAI_API_KEY || this.config.ANTHROPIC_API_KEY);
  }

  async routeMessage(messageText: string): Promise<RouterDecision | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const messageHash = hashSensitiveValue(
      messageText,
      this.config.MASTER_ENCRYPTION_KEY
    );

    try {
      const rawResponse = this.config.OPENAI_API_KEY
        ? await this.routeWithOpenAI(messageText)
        : await this.routeWithAnthropic(messageText);
      const decision = parseRouterDecision(rawResponse);

      this.logger.info(
        {
          messageHash,
          routedSkill: decision.skill,
          confidence: decision.confidence
        },
        "natural language router classified message"
      );

      return decision;
    } catch (error) {
      this.logger.warn(
        {
          messageHash,
          err: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }
        },
        "natural language router failed"
      );

      return null;
    }
  }

  private async routeWithOpenAI(messageText: string): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.OPENAI_API_KEY}`
      },
      signal: AbortSignal.timeout(this.config.ROUTER_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.OPENAI_ROUTER_MODEL,
        temperature: 0,
        messages: [
          {
            role: "developer",
            content: ROUTER_PROMPT
          },
          {
            role: "user",
            content: messageText
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI router request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    return payload.choices?.[0]?.message?.content ?? "";
  }

  private async routeWithAnthropic(messageText: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01"
      },
      signal: AbortSignal.timeout(this.config.ROUTER_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.ANTHROPIC_ROUTER_MODEL,
        max_tokens: 200,
        temperature: 0,
        system: ROUTER_PROMPT,
        messages: [
          {
            role: "user",
            content: messageText
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic router request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };

    return payload.content
      ?.filter(item => item.type === "text" && typeof item.text === "string")
      .map(item => item.text)
      .join("\n") ?? "";
  }
}

export function parseRouterDecision(rawText: string): RouterDecision {
  const parsed = routerDecisionSchema.safeParse(extractJsonObject(rawText));

  if (!parsed.success) {
    throw new Error("Router response was not valid JSON");
  }

  return parsed.data;
}

export function extractSkillInput(decision: RouterDecision): string | null {
  switch (decision.skill) {
    case "research":
      return typeof decision.args.query === "string" ? decision.args.query.trim() : null;
    case "enrich":
      return typeof decision.args.email === "string" ? decision.args.email.trim() : null;
    case "generate":
      return typeof decision.args.prompt === "string" ? decision.args.prompt.trim() : null;
    case "none":
      return null;
  }
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();

  if (!trimmed) {
    throw new Error("Router returned an empty response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Router response did not contain JSON");
    }

    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
