import type { Context } from "telegraf";
import { AppDatabase } from "../db/client.js";
import { WalletManager } from "../wallets/walletManager.js";
import { formatUsdAmount, getExecutionContext } from "./helpers.js";
import { replyWithError } from "./replyWithError.js";

export function createBalanceCommand(deps: {
  db: AppDatabase;
  walletManager: WalletManager;
}) {
  return async (ctx: Context) => {
    try {
      const executionContext = getExecutionContext(ctx);
      const { user, wallet, balance } = await deps.walletManager.getBalance(
        executionContext.telegramId,
        executionContext.telegramProfile
      );

      deps.db.upsertSession({
        userId: user.id,
        telegramChatId: executionContext.telegramChatId,
        currentCommand: "balance",
        stateJson: null
      });

      await ctx.reply(
        [
          `Wallet address: ${WalletManager.maskAddress(balance.address ?? wallet.address)}`,
          `Balance: ${
            typeof balance.usdcBalance === "number"
              ? `${formatUsdAmount(balance.usdcBalance)} USDC`
              : "unavailable"
          }`,
          `Spend cap: ${
            user.cap_enabled ? `${formatUsdAmount(deps.walletManager.getSpendCap(user))} USDC` : "off"
          }`,
          balance.depositLink ? `Deposit link: ${balance.depositLink}` : "Deposit link: unavailable"
        ].join("\n")
      );
    } catch (error) {
      await replyWithError(ctx, error);
    }
  };
}
