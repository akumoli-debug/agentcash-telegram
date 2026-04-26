-- Spend analytics indexes: speed up per-wallet and per-group analytics queries.

-- Per-wallet analytics (user wallets use wallet_id, not group_id)
CREATE INDEX IF NOT EXISTS transactions_wallet_created_at_idx
ON transactions(wallet_id, created_at DESC);

-- Per-wallet replay attempt queries
CREATE INDEX IF NOT EXISTS preflight_attempts_wallet_created_at_idx
ON preflight_attempts(wallet_id, created_at DESC);
