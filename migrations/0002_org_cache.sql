-- Org membership is checked at sign-in and cached here (we never keep GitHub tokens).
ALTER TABLE users ADD COLUMN org_member INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN org_checked_at INTEGER;
