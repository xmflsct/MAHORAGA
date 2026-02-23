-- Stores running totals of AI Gateway cost data, synced incrementally.
-- Only one row (id = 1) is ever used — updated on each sync.

CREATE TABLE IF NOT EXISTS gateway_cost_cache (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_cost REAL NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  last_log_created_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO gateway_cost_cache (id) VALUES (1);
