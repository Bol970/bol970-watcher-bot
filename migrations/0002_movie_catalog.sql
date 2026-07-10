ALTER TABLE media_titles ADD COLUMN release_year INTEGER;
ALTER TABLE media_titles ADD COLUMN rating REAL;
ALTER TABLE media_titles ADD COLUMN not_aired INTEGER;
ALTER TABLE media_titles ADD COLUMN catalog_first_seen_at TEXT;
ALTER TABLE media_titles ADD COLUMN catalog_last_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_media_titles_catalog
  ON media_titles(media_type, catalog_first_seen_at, not_aired, release_year);
