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
        "/cap <amount> - set a per-call cap",
        "/cap off - disable user cap confirmations",
        "/research <topic> - plan a multi-step agentic research report",
        "/search <query> - run the single-call Exa search skill",
        "/enrich <email> - run the enrichment skill",
        "/generate <prompt> - run the image generation skill",
        "/history - show your last 10 transactions",
        "",
        "Calls above your cap or the MVP hard cap are blocked.",
        "Every paid call creates an immutable quote record before execution."
      ].join("\n")
    );
  };
}
