import type {
  ArticleDetail,
  ArticleRow,
  BarometerPoint,
  ImageAnalysisRow,
  KeywordKind,
  KeywordRow,
  SentimentLabel,
  SentimentRow,
  SubscriptionPriceRow,
} from './schema.ts';

export interface ScrapedArticle {
  url: string;
  title: string;
  published_at: string;
  is_paywalled: boolean;
  unit_price_chf: number | null;
  preview_text: string | null;
  full_text: string | null;
  hero_image_url: string | null;
}

export async function upsertArticle(db: D1Database, a: ScrapedArticle): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO article (url, title, published_at, is_paywalled, unit_price_chf,
                            preview_text, full_text, hero_image_url, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title          = excluded.title,
         published_at   = excluded.published_at,
         is_paywalled   = excluded.is_paywalled,
         unit_price_chf = excluded.unit_price_chf,
         preview_text   = excluded.preview_text,
         full_text      = excluded.full_text,
         hero_image_url = excluded.hero_image_url,
         scraped_at     = excluded.scraped_at
       RETURNING id`,
    )
    .bind(
      a.url,
      a.title,
      a.published_at,
      a.is_paywalled ? 1 : 0,
      a.unit_price_chf,
      a.preview_text,
      a.full_text,
      a.hero_image_url,
      now,
    )
    .first<{ id: number }>();
  if (!result) throw new Error(`upsertArticle returned no row for ${a.url}`);
  return result.id;
}

export async function listUnenriched(db: D1Database, limit: number): Promise<ArticleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM article WHERE enriched_at IS NULL ORDER BY published_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ArticleRow>();
  return results ?? [];
}

export async function existingUrls(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT url FROM article`).all<{ url: string }>();
  return new Set((results ?? []).map((r) => r.url));
}

export interface EnrichmentInput {
  article_id: number;
  sentiment: { label: SentimentLabel; score: number; rationale: string | null };
  keywords: Array<{ term: string; term_en: string | null; kind: KeywordKind }>;
  images: Array<{
    image_url: string;
    is_hero: boolean;
    pop_culture_source: string | null;
    ai_generated_likelihood: number | null;
    notes: string | null;
  }>;
}

export async function persistEnrichment(db: D1Database, e: EnrichmentInput): Promise<void> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM keyword WHERE article_id = ?`).bind(e.article_id),
    db.prepare(`DELETE FROM image_analysis WHERE article_id = ?`).bind(e.article_id),
    db
      .prepare(
        `INSERT INTO sentiment (article_id, label, score, rationale)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(article_id) DO UPDATE SET
           label = excluded.label, score = excluded.score, rationale = excluded.rationale`,
      )
      .bind(e.article_id, e.sentiment.label, e.sentiment.score, e.sentiment.rationale),
  ];
  for (const k of e.keywords) {
    stmts.push(
      db
        .prepare(`INSERT INTO keyword (article_id, term, term_en, kind) VALUES (?, ?, ?, ?)`)
        .bind(e.article_id, k.term, k.term_en, k.kind),
    );
  }
  for (const i of e.images) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO image_analysis (article_id, image_url, is_hero, pop_culture_source,
                                       ai_generated_likelihood, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          e.article_id,
          i.image_url,
          i.is_hero ? 1 : 0,
          i.pop_culture_source,
          i.ai_generated_likelihood,
          i.notes,
        ),
    );
  }
  stmts.push(db.prepare(`UPDATE article SET enriched_at = ? WHERE id = ?`).bind(now, e.article_id));
  await db.batch(stmts);
}

export async function getBarometer(
  db: D1Database,
  opts: { since?: string; limit?: number } = {},
): Promise<BarometerPoint[]> {
  const since = opts.since ?? '1970-01-01';
  const limit = opts.limit ?? 1000;
  const { results } = await db
    .prepare(
      `SELECT a.id            AS article_id,
              a.url           AS url,
              a.title         AS title,
              a.published_at  AS published_at,
              a.unit_price_chf AS unit_price_chf,
              a.is_paywalled  AS is_paywalled,
              a.hero_image_url AS hero_image_url,
              s.label         AS sentiment_label,
              s.score         AS sentiment_score
         FROM article a
         LEFT JOIN sentiment s ON s.article_id = a.id
        WHERE a.unit_price_chf IS NOT NULL
          AND a.published_at >= ?
        ORDER BY a.published_at ASC
        LIMIT ?`,
    )
    .bind(since, limit)
    .all<BarometerPoint>();
  return results ?? [];
}

export async function latestSubscriptionPrice(
  db: D1Database,
): Promise<SubscriptionPriceRow | null> {
  return db
    .prepare(`SELECT * FROM subscription_price ORDER BY observed_at DESC LIMIT 1`)
    .first<SubscriptionPriceRow>();
}

export async function getArticleDetail(
  db: D1Database,
  id: number,
): Promise<ArticleDetail | null> {
  const article = await db
    .prepare(`SELECT * FROM article WHERE id = ?`)
    .bind(id)
    .first<ArticleRow>();
  if (!article) return null;
  const [{ results: keywords }, sentiment, { results: images }] = await Promise.all([
    db
      .prepare(`SELECT * FROM keyword WHERE article_id = ? ORDER BY kind, term`)
      .bind(id)
      .all<KeywordRow>(),
    db
      .prepare(`SELECT * FROM sentiment WHERE article_id = ?`)
      .bind(id)
      .first<SentimentRow>(),
    db
      .prepare(`SELECT * FROM image_analysis WHERE article_id = ?`)
      .bind(id)
      .all<ImageAnalysisRow>(),
  ]);
  return {
    ...article,
    keywords: keywords ?? [],
    sentiment: sentiment ?? null,
    images: images ?? [],
  };
}

export interface KeywordFrequency {
  term: string;
  term_en: string | null;
  kind: KeywordKind;
  article_count: number;
}

export async function getKeywordFrequencies(
  db: D1Database,
  opts: { kind?: KeywordKind; limit?: number } = {},
): Promise<KeywordFrequency[]> {
  const limit = opts.limit ?? 50;
  const where = opts.kind ? `WHERE kind = ?` : '';
  const stmt = db.prepare(
    `SELECT term, term_en, kind, COUNT(DISTINCT article_id) AS article_count
       FROM keyword
       ${where}
       GROUP BY term, kind
       ORDER BY article_count DESC, term ASC
       LIMIT ?`,
  );
  const bound = opts.kind ? stmt.bind(opts.kind, limit) : stmt.bind(limit);
  const { results } = await bound.all<KeywordFrequency>();
  return results ?? [];
}
