import type { Context } from "telegraf";
import { AppDatabase } from "../db/client.js";
import { WalletManager } from "../wallets/walletManager.js";
import { getExecutionContext } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export function createDepositCommand(deps: {
  db: AppDatabase;
  walletManager: WalletManager;
}) {
  return async (ctx: Context) => {
    try {
      const executionContext = getExecutionContext(ctx);
      const { user, deposit } = await deps.walletManager.getDepositAddress(
        executionContext.telegramId,
        executionContext.telegramProfile
      );

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: executionContext.telegramChatId,
        currentCommand: "deposit",
        stateJson: null
      });

      const qrDataUrl = await deps.walletManager.getDepositQrDataUrl(deposit.address ?? "");
      const base64 = qrDataUrl.split(",")[1];

      await ctx.replyWithPhoto(
        { source: Buffer.from(base64 ?? "", "base64") },
        {
          caption: [
            `Deposit address: ${deposit.address ?? "unavailable"}`,
            deposit.depositLink ? `Deposit link: ${deposit.depositLink}` : "Deposit link: unavailable"
          ].join("\n")
        }
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
