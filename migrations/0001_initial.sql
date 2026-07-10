PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'teacher')),
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_item_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_events (
  event_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  category TEXT NOT NULL,
  category_normalized TEXT NOT NULL,
  author TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('live', 'upcoming')),
  url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_events_scheduled
  ON live_events(status, scheduled_at);

CREATE TABLE IF NOT EXISTS media_titles (
  media_key TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('series', 'movie')),
  title_ru TEXT NOT NULL,
  title_en TEXT,
  title_normalized TEXT NOT NULL,
  url TEXT NOT NULL,
  genres_json TEXT NOT NULL DEFAULT '[]',
  metadata_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_titles_normalized
  ON media_titles(title_normalized);

CREATE TABLE IF NOT EXISTS lostfilm_events (
  event_key TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('series_episode', 'series', 'movie')),
  title_ru TEXT NOT NULL,
  title_en TEXT,
  title_normalized TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  scheduled_date TEXT,
  first_scheduled_date TEXT,
  released_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'released', 'date_passed')),
  url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (media_key) REFERENCES media_titles(media_key)
);

CREATE INDEX IF NOT EXISTS idx_lostfilm_events_dates
  ON lostfilm_events(status, scheduled_date, released_date);
CREATE INDEX IF NOT EXISTS idx_lostfilm_events_title
  ON lostfilm_events(title_normalized);

CREATE TABLE IF NOT EXISTS lostfilm_date_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  old_date TEXT,
  new_date TEXT,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (event_key) REFERENCES lostfilm_events(event_key)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('lessons', 'media')),
  filter_type TEXT NOT NULL CHECK (filter_type IN ('category', 'title', 'genre')),
  filter_value TEXT NOT NULL,
  filter_normalized TEXT NOT NULL,
  media_scope TEXT NOT NULL DEFAULT 'both' CHECK (media_scope IN ('series', 'movie', 'both')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
  UNIQUE (telegram_id, domain, filter_type, filter_normalized, media_scope)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_active
  ON subscriptions(active, domain);

CREATE TABLE IF NOT EXISTS dialog_sessions (
  telegram_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  step TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_log (
  notification_key TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS refresh_locks (
  name TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
