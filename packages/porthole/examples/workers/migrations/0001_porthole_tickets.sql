CREATE TABLE IF NOT EXISTS porthole_tickets (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS porthole_tickets_expires_at ON porthole_tickets (expires_at);
