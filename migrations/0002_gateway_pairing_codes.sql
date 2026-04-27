-- Gateway pairing codes: one-time codes allowing unallowlisted users to pair
-- with the bot in a private chat. Codes are issued only in private/DM, never in groups.
CREATE TABLE IF NOT EXISTS gateway_pairing_codes (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  actor_id_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE INDEX IF NOT EXISTS gateway_pairing_codes_actor_platform_status_idx
ON gateway_pairing_codes(platform, actor_id_hash, status, expires_at DESC);
