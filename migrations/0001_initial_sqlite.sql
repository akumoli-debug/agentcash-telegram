CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  cap_enabled INTEGER NOT NULL DEFAULT 1,
  default_spend_cap_usdc REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_identities (
  user_hash TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
  owner_user_id TEXT,
  owner_group_id TEXT,
  home_dir_hash TEXT,
  address TEXT,
  network TEXT,
  deposit_link TEXT,
  wallet_ref TEXT,
  signer_backend TEXT NOT NULL DEFAULT 'local_cli',
  public_address TEXT,
  active_key_version INTEGER,
  encrypted_private_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'user' AND owner_user_id IS NOT NULL AND owner_group_id IS NULL) OR (kind = 'group' AND owner_group_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_owner_unique ON wallets(owner_user_id, kind) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallets_home_dir_hash_unique ON wallets(home_dir_hash) WHERE home_dir_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  telegram_chat_id_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'telegram',
  guild_id_hash TEXT,
  title_hash TEXT,
  wallet_id TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL,
  cap_enabled INTEGER NOT NULL DEFAULT 1,
  spend_cap_usdc REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_group_role_idx ON group_members(group_id, role);

CREATE TABLE IF NOT EXISTS telegram_admin_verifications (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  telegram_status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_admin_verifications_group_user_expires_idx ON telegram_admin_verifications(group_id, user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  canonical_request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  quoted_cost_cents INTEGER NOT NULL,
  max_approved_cost_cents INTEGER NOT NULL,
  is_dev_unquoted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','executing','succeeded','expired','canceled','failed','execution_unknown')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  executed_at TEXT,
  transaction_id TEXT,
  execution_started_at TEXT,
  execution_lease_expires_at TEXT,
  execution_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_execution_error TEXT,
  upstream_idempotency_key TEXT,
  reconciliation_status TEXT,
  reconciled_at TEXT,
  requester_user_id TEXT,
  group_id TEXT,
  requires_group_admin_approval INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'telegram',
  actor_id_hash TEXT,
  wallet_scope TEXT
);

CREATE INDEX IF NOT EXISTS quotes_user_hash_created_at_idx ON quotes(user_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_status_expires_at_idx ON quotes(status, expires_at);
CREATE INDEX IF NOT EXISTS quotes_execution_reconciliation_idx ON quotes(status, execution_lease_expires_at);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_id TEXT,
  session_id TEXT,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT,
  telegram_id_hash TEXT,
  group_id TEXT,
  command_name TEXT NOT NULL,
  skill TEXT,
  origin TEXT,
  endpoint TEXT,
  quote_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'quoted', 'submitted', 'success', 'error')),
  quoted_price_usdc REAL,
  actual_price_usdc REAL,
  estimated_cost_cents INTEGER,
  actual_cost_cents INTEGER,
  tx_hash TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  response_hash TEXT,
  request_summary TEXT,
  response_summary TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_user_created_at_idx ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_group_created_at_idx ON transactions(group_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_key_unique ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  current_command TEXT,
  state_json TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS preflight_attempts (
  id TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  wallet_id TEXT,
  skill TEXT NOT NULL,
  endpoint TEXT,
  request_hash TEXT,
  failure_stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  safe_error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS preflight_attempts_user_hash_idx ON preflight_attempts(user_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  wallet_id TEXT,
  quote_id TEXT,
  transaction_id TEXT,
  actor_hash TEXT,
  group_id TEXT,
  status TEXT,
  metadata_json TEXT,
  shipped_at TEXT,
  ship_attempts INTEGER NOT NULL DEFAULT 0,
  last_ship_error TEXT,
  sink_name TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_name_created_at_idx ON audit_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_quote_idx ON audit_events(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_unshipped_idx ON audit_events(shipped_at, created_at ASC);

CREATE TABLE IF NOT EXISTS inline_payloads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS inline_payloads_expires_at_idx ON inline_payloads(expires_at);

CREATE TABLE IF NOT EXISTS key_versions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  signer_backend TEXT NOT NULL,
  public_address TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')),
  created_at TEXT NOT NULL,
  deprecated_at TEXT,
  UNIQUE(wallet_id, version)
);

CREATE INDEX IF NOT EXISTS key_versions_wallet_status_idx ON key_versions(wallet_id, status);

CREATE TABLE IF NOT EXISTS wallet_keys (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  key_version_id TEXT NOT NULL,
  encrypted_private_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS wallet_keys_wallet_idx ON wallet_keys(wallet_id, created_at DESC);
