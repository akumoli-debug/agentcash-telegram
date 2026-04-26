-- Policy engine tables: per-wallet caps, per-skill overrides, and immutable decision log.

CREATE TABLE IF NOT EXISTS wallet_policies (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL UNIQUE,
  daily_cap_usdc REAL,
  weekly_cap_usdc REAL,
  skill_allowlist TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id)
);

CREATE TABLE IF NOT EXISTS skill_policies (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'trusted', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  UNIQUE (wallet_id, skill)
);

CREATE INDEX IF NOT EXISTS skill_policies_wallet_idx
ON skill_policies(wallet_id, skill);

-- Immutable policy snapshot stored with every quote for auditability.
-- Changing policy rules after a quote is issued does NOT rewrite existing rows.
CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  wallet_id TEXT NOT NULL,
  actor_id_hash TEXT,
  outcome TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  reason TEXT,
  snapshot_json TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(id)
);

CREATE INDEX IF NOT EXISTS policy_decisions_wallet_decided_at_idx
ON policy_decisions(wallet_id, decided_at DESC);
