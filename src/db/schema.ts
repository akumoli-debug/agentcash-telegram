export const schemaStatements = [
  `
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
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
      owner_user_id TEXT,
      owner_group_id TEXT,
      home_dir_hash TEXT,
      address TEXT,
      network TEXT,
      deposit_link TEXT,
      encrypted_private_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (kind = 'user' AND owner_user_id IS NOT NULL AND owner_group_id IS NULL) OR
        (kind = 'group' AND owner_group_id IS NOT NULL)
      ),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_owner_unique
    ON wallets(owner_user_id, kind)
    WHERE owner_user_id IS NOT NULL
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS wallets_home_dir_hash_unique
    ON wallets(home_dir_hash)
    WHERE home_dir_hash IS NOT NULL
  `,
  `
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      wallet_id TEXT,
      session_id TEXT,
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id TEXT,
      telegram_id_hash TEXT,
      command_name TEXT NOT NULL,
      skill TEXT,
      origin TEXT,
      endpoint TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'quoted', 'submitted', 'success', 'error')),
      quoted_price_usdc REAL,
      actual_price_usdc REAL,
      estimated_cost_cents INTEGER,
      actual_cost_cents INTEGER,
      tx_hash TEXT,
      request_hash TEXT,
      response_hash TEXT,
      request_summary TEXT,
      response_summary TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS transactions_user_created_at_idx
    ON transactions(user_id, created_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS transactions_telegram_hash_created_at_idx
    ON transactions(telegram_id_hash, created_at DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL,
      current_command TEXT,
      state_json TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_chat_unique
    ON sessions(user_id, telegram_chat_id)
  `,
  `
    CREATE TABLE IF NOT EXISTS request_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS request_events_user_created_at_idx
    ON request_events(user_id, created_at DESC)
  `
] as const;
