import type { AppDatabase, QuoteRow } from "../db/client.js";
import type { AppLogger } from "../lib/logger.js";

export interface ExecutionReconciliationResult {
  inspected: number;
  markedSucceeded: number;
  markedUnknown: number;
}

export class ExecutionReconciler {
  constructor(
    private readonly db: Pick<
      AppDatabase,
      | "listExpiredExecutingQuotes"
      | "getLatestTransactionForQuote"
      | "transitionQuoteStatus"
      | "markQuoteExecutionUnknown"
    >,
    private readonly logger: Pick<AppLogger, "info" | "warn">
  ) {}

  runOnce(now = new Date().toISOString(), limit = 50): ExecutionReconciliationResult {
    const quotes = this.db.listExpiredExecutingQuotes(now, limit);
    const result: ExecutionReconciliationResult = {
      inspected: quotes.length,
      markedSucceeded: 0,
      markedUnknown: 0
    };

    for (const quote of quotes) {
      if (this.reconcileQuote(quote)) {
        result.markedSucceeded += 1;
      } else {
        result.markedUnknown += 1;
      }
    }

    return result;
  }

  private reconcileQuote(quote: QuoteRow): boolean {
    const transaction = this.db.getLatestTransactionForQuote(quote.id);

    if (transaction) {
      const transactionId = String(transaction.id ?? "");
      const succeeded = this.db.transitionQuoteStatus(quote.id, "executing", "succeeded", {
        executedAt: new Date().toISOString(),
        transactionId
      });
      if (succeeded) {
        this.logger.info(
          {
            quoteId: quote.id,
            walletId: quote.wallet_id,
            transactionId,
            requestHash: quote.request_hash
          },
          "reconciled expired executing quote from existing transaction"
        );
      }
      return succeeded;
    }

    this.db.markQuoteExecutionUnknown(
      quote.id,
      "Execution lease expired and upstream reconciliation is unavailable; operator review required."
    );
    this.logger.warn(
      {
        quoteId: quote.id,
        walletId: quote.wallet_id,
        requestHash: quote.request_hash,
        upstreamIdempotencyKey: quote.upstream_idempotency_key
      },
      "marked expired executing quote as execution_unknown"
    );
    return false;
  }
}
