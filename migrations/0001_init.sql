-- Accounts, passkeys, devices, and the sealed Azeroth Survivors save.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  recovery_hash TEXT
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS credentials_user_id ON credentials(user_id);

-- Short-lived WebAuthn challenges. The row id travels in an HttpOnly cookie.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT,
  data TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_version INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS saves (
  user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  save TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT,
  device_name TEXT
);

CREATE TABLE IF NOT EXISTS save_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  save TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  device_name TEXT,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS save_history_user_id ON save_history(user_id, id DESC);
