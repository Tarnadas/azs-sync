-- One account-level pairing key. The dashboard shows this as a QR/setup link,
-- so there is no "create a device" step and no phantom device rows.
ALTER TABLE users ADD COLUMN pairing_token TEXT;
ALTER TABLE users ADD COLUMN pairing_token_hash TEXT;
CREATE INDEX IF NOT EXISTS users_pairing_token_hash ON users(pairing_token_hash);
