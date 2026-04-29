-- Baromontres D1 schema — single source of truth for the SQLite database.

CREATE TABLE IF NOT EXISTS article (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  published_at    TEXT    NOT NULL,
  is_paywalled    INTEGER NOT NULL DEFAULT 0,
  unit_price_chf  REAL,
  preview_text    TEXT,
  full_text       TEXT,
  hero_image_url  TEXT,
  scraped_at      TEXT    NOT NULL,
  enriched_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_article_published ON article(published_at);
CREATE INDEX IF NOT EXISTS idx_article_paywalled ON article(is_paywalled);

CREATE TABLE IF NOT EXISTS subscription_price (
  observed_at TEXT PRIMARY KEY,
  price_chf   REAL NOT NULL,
  period      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  term       TEXT    NOT NULL,
  term_en    TEXT,
  kind       TEXT    NOT NULL CHECK (kind IN ('brand','topic','person','model'))
);
CREATE INDEX IF NOT EXISTS idx_keyword_article ON keyword(article_id);
CREATE INDEX IF NOT EXISTS idx_keyword_term    ON keyword(term);
CREATE INDEX IF NOT EXISTS idx_keyword_kind    ON keyword(kind);

CREATE TABLE IF NOT EXISTS sentiment (
  article_id INTEGER PRIMARY KEY REFERENCES article(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL CHECK (label IN ('positive','neutral','negative')),
  score      REAL    NOT NULL,
  rationale  TEXT
);

CREATE TABLE IF NOT EXISTS image_analysis (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id               INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  image_url                TEXT    NOT NULL,
  is_hero                  INTEGER NOT NULL DEFAULT 0,
  pop_culture_source       TEXT,
  ai_generated_likelihood  REAL,
  notes                    TEXT,
  UNIQUE(article_id, image_url)
);
CREATE INDEX IF NOT EXISTS idx_image_article ON image_analysis(article_id);
CREATE INDEX IF NOT EXISTS idx_image_pop     ON image_analysis(pop_culture_source);
