-- Keep the raw device token so the dashboard can show a copyable pairing
-- link again later. The token is still hashed for authentication.
ALTER TABLE devices ADD COLUMN token TEXT;
