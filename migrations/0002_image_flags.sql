-- Add image provenance and manipulation detection columns (forward-only; existing rows stay NULL).
ALTER TABLE image_analysis ADD COLUMN not_watch_image INTEGER;
ALTER TABLE image_analysis ADD COLUMN has_text_overlay INTEGER;
ALTER TABLE image_analysis ADD COLUMN source_clue TEXT;
CREATE INDEX IF NOT EXISTS idx_image_not_watch    ON image_analysis(not_watch_image);
CREATE INDEX IF NOT EXISTS idx_image_text_overlay ON image_analysis(has_text_overlay);
