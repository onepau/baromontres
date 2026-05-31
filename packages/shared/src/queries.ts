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
} from "./schema.ts";

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

export async function upsertArticle(
  db: D1Database,
  a: ScrapedArticle,
): Promise<number> {
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

export async function listUnenriched(
  db: D1Database,
  limit: number,
): Promise<ArticleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM article WHERE enriched_at IS NULL ORDER BY published_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ArticleRow>();
  return results ?? [];
}

export async function getArticleByUrl(
  db: D1Database,
  url: string,
): Promise<ArticleRow | null> {
  return (
    db
      .prepare(`SELECT * FROM article WHERE url = ?`)
      .bind(url)
      .first<ArticleRow>() ?? null
  );
}

export async function existingUrls(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT url FROM article`)
    .all<{ url: string }>();
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
    not_watch_image: boolean | null;
    has_text_overlay: boolean | null;
    source_clue: string | null;
    notes: string | null;
  }>;
}

export async function persistEnrichment(
  db: D1Database,
  e: EnrichmentInput,
): Promise<void> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM keyword WHERE article_id = ?`).bind(e.article_id),
    db
      .prepare(`DELETE FROM image_analysis WHERE article_id = ?`)
      .bind(e.article_id),
    db
      .prepare(
        `INSERT INTO sentiment (article_id, label, score, rationale)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(article_id) DO UPDATE SET
           label = excluded.label, score = excluded.score, rationale = excluded.rationale`,
      )
      .bind(
        e.article_id,
        e.sentiment.label,
        e.sentiment.score,
        e.sentiment.rationale,
      ),
  ];
  for (const k of e.keywords) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO keyword (article_id, term, term_en, kind) VALUES (?, ?, ?, ?)`,
        )
        .bind(e.article_id, k.term, k.term_en, k.kind),
    );
  }
  for (const i of e.images) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO image_analysis (article_id, image_url, is_hero, pop_culture_source,
                                       ai_generated_likelihood, not_watch_image,
                                       has_text_overlay, source_clue, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          e.article_id,
          i.image_url,
          i.is_hero ? 1 : 0,
          i.pop_culture_source,
          i.ai_generated_likelihood,
          i.not_watch_image === null ? null : i.not_watch_image ? 1 : 0,
          i.has_text_overlay === null ? null : i.has_text_overlay ? 1 : 0,
          i.source_clue,
          i.notes,
        ),
    );
  }
  stmts.push(
    db
      .prepare(`UPDATE article SET enriched_at = ? WHERE id = ?`)
      .bind(now, e.article_id),
  );
  await db.batch(stmts);
}

export async function getBarometer(
  db: D1Database,
  opts: { since?: string; limit?: number } = {},
): Promise<BarometerPoint[]> {
  const since = opts.since ?? "1970-01-01";
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
    .prepare(
      `SELECT * FROM subscription_price ORDER BY observed_at DESC LIMIT 1`,
    )
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
  const [{ results: keywords }, sentiment, { results: images }] =
    await Promise.all([
      db
        .prepare(
          `SELECT * FROM keyword WHERE article_id = ? ORDER BY kind, term`,
        )
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

export interface FlaggedImage {
  article_id: number;
  url: string;
  title: string;
  published_at: string;
  image_url: string;
  pop_culture_source: string | null;
  ai_generated_likelihood: number | null;
  not_watch_image: 0 | 1 | null;
  has_text_overlay: 0 | 1 | null;
  source_clue: string | null;
  notes: string | null;
}

export async function getFlaggedImages(
  db: D1Database,
  opts: { limit?: number } = {},
): Promise<FlaggedImage[]> {
  const limit = opts.limit ?? 12;
  const { results } = await db
    .prepare(
      `SELECT a.id            AS article_id,
              a.url           AS url,
              a.title         AS title,
              a.published_at  AS published_at,
              i.image_url     AS image_url,
              i.pop_culture_source     AS pop_culture_source,
              i.ai_generated_likelihood AS ai_generated_likelihood,
              i.not_watch_image        AS not_watch_image,
              i.has_text_overlay       AS has_text_overlay,
              i.source_clue            AS source_clue,
              i.notes                  AS notes
         FROM image_analysis i
         JOIN article a ON a.id = i.article_id
        WHERE i.pop_culture_source IS NOT NULL
           OR (i.ai_generated_likelihood IS NOT NULL AND i.ai_generated_likelihood >= 0.5)
           OR i.not_watch_image = 1
           OR i.has_text_overlay = 1
           OR i.source_clue IS NOT NULL
        ORDER BY a.published_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<FlaggedImage>();
  return results ?? [];
}

export interface ImageDiagnostics {
  article_total: number;
  article_enriched: number;
  article_with_hero: number;
  image_analysis_rows: number;
  image_with_pop_culture: number;
  image_with_ai_05_plus: number;
  image_with_not_watch: number;
  image_with_text_overlay: number;
  image_with_source_clue: number;
  image_with_fetch_failed: number;
  top_ai_likelihoods: Array<{
    url: string;
    image_url: string;
    ai_generated_likelihood: number;
    published_at: string;
  }>;
}

export async function getImageDiagnostics(
  db: D1Database,
): Promise<ImageDiagnostics> {
  const count = async (sql: string): Promise<number> => {
    const row = await db.prepare(sql).first<{ n: number }>();
    return row?.n ?? 0;
  };
  const [
    article_total,
    article_enriched,
    article_with_hero,
    image_analysis_rows,
    image_with_pop_culture,
    image_with_ai_05_plus,
    image_with_not_watch,
    image_with_text_overlay,
    image_with_source_clue,
    image_with_fetch_failed,
    topRows,
  ] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM article`),
    count(`SELECT COUNT(*) AS n FROM article WHERE enriched_at IS NOT NULL`),
    count(`SELECT COUNT(*) AS n FROM article WHERE hero_image_url IS NOT NULL`),
    count(`SELECT COUNT(*) AS n FROM image_analysis`),
    count(
      `SELECT COUNT(*) AS n FROM image_analysis WHERE pop_culture_source IS NOT NULL`,
    ),
    count(
      `SELECT COUNT(*) AS n FROM image_analysis
        WHERE ai_generated_likelihood IS NOT NULL
          AND ai_generated_likelihood >= 0.5`,
    ),
    count(`SELECT COUNT(*) AS n FROM image_analysis WHERE not_watch_image = 1`),
    count(
      `SELECT COUNT(*) AS n FROM image_analysis WHERE has_text_overlay = 1`,
    ),
    count(
      `SELECT COUNT(*) AS n FROM image_analysis WHERE source_clue IS NOT NULL`,
    ),
    count(
      `SELECT COUNT(*) AS n FROM image_analysis WHERE notes LIKE 'fetch_failed:%'`,
    ),
    db
      .prepare(
        `SELECT a.url AS url, i.image_url AS image_url,
                i.ai_generated_likelihood AS ai_generated_likelihood,
                a.published_at AS published_at
           FROM image_analysis i
           JOIN article a ON a.id = i.article_id
          WHERE i.ai_generated_likelihood IS NOT NULL
          ORDER BY i.ai_generated_likelihood DESC
          LIMIT 10`,
      )
      .all<{
        url: string;
        image_url: string;
        ai_generated_likelihood: number;
        published_at: string;
      }>(),
  ]);
  return {
    article_total,
    article_enriched,
    article_with_hero,
    image_analysis_rows,
    image_with_pop_culture,
    image_with_ai_05_plus,
    image_with_not_watch,
    image_with_text_overlay,
    image_with_source_clue,
    image_with_fetch_failed,
    top_ai_likelihoods: topRows.results ?? [],
  };
}

export interface RecentImageRow {
  article_id: number;
  url: string;
  title: string;
  published_at: string;
  enriched_at: string;
  image_url: string;
  pop_culture_source: string | null;
  ai_generated_likelihood: number | null;
  not_watch_image: 0 | 1 | null;
  has_text_overlay: 0 | 1 | null;
  source_clue: string | null;
  notes: string | null;
}

export async function getRecentImageAssessments(
  db: D1Database,
  limit = 5,
): Promise<RecentImageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id           AS article_id,
              a.url          AS url,
              a.title        AS title,
              a.published_at AS published_at,
              a.enriched_at  AS enriched_at,
              i.image_url    AS image_url,
              i.pop_culture_source      AS pop_culture_source,
              i.ai_generated_likelihood AS ai_generated_likelihood,
              i.not_watch_image         AS not_watch_image,
              i.has_text_overlay        AS has_text_overlay,
              i.source_clue             AS source_clue,
              i.notes                   AS notes
         FROM image_analysis i
         JOIN article a ON a.id = i.article_id
        ORDER BY a.enriched_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<RecentImageRow>();
  return results ?? [];
}

export interface ArticleMonthRow {
  month: string;
  count: number;
  with_price: number;
}

export async function getArticlesByMonth(
  db: D1Database,
): Promise<ArticleMonthRow[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(published_at, 1, 7) AS month,
              COUNT(*)                                                    AS count,
              SUM(CASE WHEN unit_price_chf IS NOT NULL THEN 1 ELSE 0 END) AS with_price
         FROM article
         WHERE published_at IS NOT NULL AND published_at <> ''
         GROUP BY month
         ORDER BY month ASC`,
    )
    .all<ArticleMonthRow>();
  return results ?? [];
}

export async function getKeywordFrequencies(
  db: D1Database,
  opts: { kind?: KeywordKind; limit?: number; min_count?: number } = {},
): Promise<KeywordFrequency[]> {
  const limit = opts.limit ?? 50;
  const minCount = opts.min_count ?? 1;
  const where = opts.kind ? `WHERE kind = ?` : "";
  const having = minCount > 1 ? `HAVING COUNT(DISTINCT article_id) >= ?` : "";
  const stmt = db.prepare(
    `SELECT term, term_en, kind, COUNT(DISTINCT article_id) AS article_count
       FROM keyword
       ${where}
       GROUP BY term, kind
       ${having}
       ORDER BY article_count DESC, term ASC
       LIMIT ?`,
  );
  const params: unknown[] = [];
  if (opts.kind) params.push(opts.kind);
  if (minCount > 1) params.push(minCount);
  params.push(limit);
  const { results } = await stmt.bind(...params).all<KeywordFrequency>();
  return results ?? [];
}

// ─── Subscription prices ────────────────────────────────────────────────────

export async function getSubscriptionPrices(
  db: D1Database,
): Promise<SubscriptionPriceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT period, price_chf, observed_at
         FROM subscription_price
        WHERE (period, observed_at) IN (
          SELECT period, MAX(observed_at)
            FROM subscription_price
           GROUP BY period
        )
        ORDER BY price_chf ASC`,
    )
    .all<SubscriptionPriceRow>();
  return results ?? [];
}

export async function upsertSubscriptionPrice(
  db: D1Database,
  period: string,
  price_chf: number,
): Promise<void> {
  const latest = await db
    .prepare(
      `SELECT price_chf FROM subscription_price
        WHERE period = ? ORDER BY observed_at DESC LIMIT 1`,
    )
    .bind(period)
    .first<{ price_chf: number }>();
  if (latest?.price_chf === price_chf) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO subscription_price (observed_at, price_chf, period) VALUES (?, ?, ?)`,
    )
    .bind(now, price_chf, period)
    .run();
}

// ─── Paywall stats ───────────────────────────────────────────────────────────

export interface PaywallStats {
  since: string;
  paywalled_count: number;
  free_count: number;
  priced_paywalled_count: number;
  total_unit_price_chf: number;
  avg_unit_price_chf: number | null;
  subscription_tiers: Record<string, number>;
}

export async function getPaywallStats(
  db: D1Database,
  opts: { since?: string } = {},
): Promise<PaywallStats> {
  const since = opts.since ?? "1970-01-01";
  const [agg, tiers] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN is_paywalled = 1 THEN 1 ELSE 0 END) AS paywalled_count,
           SUM(CASE WHEN is_paywalled = 0 THEN 1 ELSE 0 END) AS free_count,
           SUM(CASE WHEN is_paywalled = 1 AND unit_price_chf IS NOT NULL
                    THEN 1 ELSE 0 END)                       AS priced_paywalled_count,
           COALESCE(SUM(CASE WHEN is_paywalled = 1
                             THEN unit_price_chf ELSE 0 END), 0) AS total_unit_price_chf,
           AVG(CASE WHEN is_paywalled = 1 THEN unit_price_chf END) AS avg_unit_price_chf
         FROM article
         WHERE published_at >= ?`,
      )
      .bind(since)
      .first<{
        paywalled_count: number | null;
        free_count: number | null;
        priced_paywalled_count: number | null;
        total_unit_price_chf: number | null;
        avg_unit_price_chf: number | null;
      }>(),
    getSubscriptionPrices(db),
  ]);

  return {
    since,
    paywalled_count: agg?.paywalled_count ?? 0,
    free_count: agg?.free_count ?? 0,
    priced_paywalled_count: agg?.priced_paywalled_count ?? 0,
    total_unit_price_chf: agg?.total_unit_price_chf ?? 0,
    avg_unit_price_chf: agg?.avg_unit_price_chf ?? null,
    subscription_tiers: Object.fromEntries(
      tiers.map((t) => [t.period, t.price_chf]),
    ),
  };
}

// ─── Brand leaderboard ───────────────────────────────────────────────────────

export interface BrandLeaderboardRow {
  term: string;
  term_en: string | null;
  article_count: number;
  positive: number;
  neutral: number;
  negative: number;
  avg_score: number | null;
  net_sentiment: number;
}

export async function getBrandLeaderboard(
  db: D1Database,
  opts: { since?: string; limit?: number; min_count?: number } = {},
): Promise<BrandLeaderboardRow[]> {
  const since = opts.since ?? "1970-01-01";
  const limit = opts.limit ?? 20;
  const minCount = opts.min_count ?? 3;
  const { results } = await db
    .prepare(
      `SELECT k.term AS term,
              MAX(k.term_en) AS term_en,
              COUNT(DISTINCT a.id) AS article_count,
              SUM(CASE WHEN s.label = 'positive' THEN 1 ELSE 0 END) AS positive,
              SUM(CASE WHEN s.label = 'neutral'  THEN 1 ELSE 0 END) AS neutral,
              SUM(CASE WHEN s.label = 'negative' THEN 1 ELSE 0 END) AS negative,
              AVG(s.score) AS avg_score
         FROM keyword k
         JOIN article a   ON a.id = k.article_id
         LEFT JOIN sentiment s ON s.article_id = a.id
        WHERE k.kind = 'brand'
          AND a.published_at >= ?
        GROUP BY k.term
        HAVING COUNT(DISTINCT a.id) >= ?
        ORDER BY article_count DESC, term ASC
        LIMIT ?`,
    )
    .bind(since, minCount, limit)
    .all<Omit<BrandLeaderboardRow, "net_sentiment">>();

  return (results ?? []).map((r) => ({
    ...r,
    net_sentiment:
      r.article_count > 0 ? (r.positive - r.negative) / r.article_count : 0,
  }));
}
