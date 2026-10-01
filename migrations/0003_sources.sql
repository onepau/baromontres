-- Multi-source support: a source table plus article.source_id.
-- Forward-only. Existing articles are backfilled to the Business Montres source.

CREATE TABLE IF NOT EXISTS source (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                 TEXT    NOT NULL UNIQUE,
  name                 TEXT    NOT NULL,
  lang                 TEXT    NOT NULL CHECK (lang IN ('fr','en')),
  home_url             TEXT    NOT NULL,
  feed_url             TEXT,
  is_paywalled_default INTEGER NOT NULL DEFAULT 0,
  weight               REAL    NOT NULL DEFAULT 1.0,
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_lang   ON source(lang);
CREATE INDEX IF NOT EXISTS idx_source_active ON source(active);

-- Seed the existing source (the only one with per-article pricing / paywall).
INSERT OR IGNORE INTO source (slug, name, lang, home_url, feed_url, is_paywalled_default)
VALUES ('businessmontres', 'Business Montres', 'fr',
        'https://www.businessmontres.com', NULL, 1);

-- Nullable per SQLite ALTER rules, then backfill every existing row.
ALTER TABLE article ADD COLUMN source_id INTEGER REFERENCES source(id);
UPDATE article
   SET source_id = (SELECT id FROM source WHERE slug = 'businessmontres')
 WHERE source_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_article_source ON article(source_id);
