-- Schema for ChordSync Companion (sqlite3)

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS track_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_utc TEXT NOT NULL,
  canonical_title TEXT NOT NULL,
  canonical_artist TEXT NOT NULL,
  canonical_album TEXT,
  variant_flags TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_provider TEXT,
  raw_title TEXT,
  raw_artist TEXT,
  raw_album TEXT
);

CREATE TABLE IF NOT EXISTS lyrics_cache (
  cache_key TEXT PRIMARY KEY,
  created_at_utc TEXT NOT NULL,
  provider TEXT NOT NULL,
  track TEXT,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER,
  plain_lyrics TEXT,
  synced_lyrics_lrc TEXT,
  source_url TEXT,
  match_confidence REAL NOT NULL,
  match_notes TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trusted_sources (
  domain TEXT PRIMARY KEY,
  language TEXT,
  trust_score REAL NOT NULL,
  strategy_id TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS debug_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_utc TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

