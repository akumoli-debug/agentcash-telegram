import type { Context } from "telegraf";

export function createHelpCommand() {
  return async (ctx: Context) => {
    await ctx.reply(
      [
        "Commands:",
        "/start - initialize your account",
        "/help - show this message",
        "/balance - show wallet balance and spend cap",
        "/deposit - show deposit details",
        "/cap show - show your per-call cap",
        "/cap <amount> - set a per-call confirmation cap",
        "/cap off - disable user cap confirmations",
        "/research <query> - run the research skill",
        "/enrich <email> - run the enrichment skill",
        "/generate <prompt> - run the image generation skill",
        "",
        "Calls above your cap ask for confirmation. Calls above the MVP hard cap are blocked."
      ].join("\n")
    );
  };
}
