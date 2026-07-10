ALTER TABLE media_titles ADD COLUMN catalog_rank INTEGER;

DROP INDEX IF EXISTS idx_media_titles_catalog;
CREATE INDEX idx_media_titles_catalog
  ON media_titles(media_type, catalog_first_seen_at, catalog_rank, not_aired, release_year);
