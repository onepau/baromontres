-- Seed additional watch-press sources for the cross-publication panel.
-- feed_url = NULL sources use per-source HTML listing adapters in the cron.
INSERT OR IGNORE INTO source (slug, name, lang, home_url, feed_url, weight)
VALUES
  ('fratello',      'Fratello',        'en', 'https://www.fratellowatches.com', 'https://www.fratellowatches.com/feed',  1.0),
  ('ablogtowatch',  'aBlogtoWatch',    'en', 'https://www.ablogtowatch.com',    'https://www.ablogtowatch.com/feed',     1.0),
  ('monochrome',    'Monochrome',      'en', 'https://monochrome-watches.com',  'https://monochrome-watches.com/feed',   1.0),
  ('watchpro',      'WatchPro',        'en', 'https://www.watchpro.com',        'https://www.watchpro.com/feed',         1.0),
  ('europastar',    'Europa Star',     'fr', 'https://www.europastar.ch',       NULL,                                    1.0),
  ('worldtempus',   'WorldTempus',     'fr', 'https://fr.worldtempus.com',      NULL,                                    1.0),
  ('montresdeluxe', 'Montres de Luxe', 'fr', 'https://www.montres-de-luxe.com', NULL,                                    1.0),
  ('hhjournal',     'HH Journal',      'fr', 'https://www.hautehorlogerie.org', NULL,                                    1.0);
