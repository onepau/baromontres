import type { Env } from "@baromontres/shared/schema";
import {
  listUnenriched,
  upsertArticle,
  existingUrls,
  getArticleByUrl,
  getSourceBySlug,
} from "@baromontres/shared/queries";
import {
  discoverArticleUrls,
  discoverFromHomepagePages,
  discoverFromSitemap,
  fetchAndParse,
  probeArchivePage,
} from "./scrape.ts";
import { enrichArticle } from "./enrich.ts";

// How to backfill (operator recipe):
//   <WEB>  = the site host (also serves /api/*), e.g. baromontres.<acc>.workers.dev
//   <CRON> = the cron worker host, e.g. baromontres-cron.<acc>.workers.dev
//
//   # 1. See what we have, by month:
//   curl https://<WEB>/api/diag/articles_by_month | jq
//
//   # 2. See what's actually on archive page N (read-only, no DB write):
//   curl https://<CRON>/probe?page=12 | jq
//
//   # 2b. Scrape (and optionally enrich) a single article URL:
//   curl -X POST 'https://<CRON>/scrape?url=https://businessmontres.com/article/...&enrich=1' | jq
//
//   # 3. Fill a date range from the /archives pages. Only articles whose published_at is in
//   #    [from_date, to_date] are inserted; the page walk stops once
//   #    the oldest scraped article drops below from_date. Re-run the
//   #    same call until {scraped:0} — dedupe handles overlap.
//   curl -X POST 'https://<CRON>/run?start_page=1&pages=50&from_date=2025-05-01&to_date=2026-03-31&enrich_limit=0&scrape_max=50'
//
//   # 4. Backfill articles missing from /archives that appear on homepage pagination (?page=N).
//   #    Walk pages 1..100 in batches; re-run until {scraped:0}.
//   curl -X POST 'https://<CRON>/run?use_homepage=1&start_page=1&pages=20&enrich_limit=0&scrape_max=50'
//   curl -X POST 'https://<CRON>/run?use_homepage=1&start_page=21&pages=20&enrich_limit=0&scrape_max=50'
//   # ... continue until no new articles are found
//
//   # 5. Drain enrichment afterwards:
//   curl -X POST 'https://<CRON>/run?enrich_limit=20'

interface CronEnv extends Env {
  SCRAPE_LIMIT: string;
  ENRICH_LIMIT: string;
  LISTING_PAGES: string;
  USER_AGENT: string;
  SOURCE_BASE: string;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: CronEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
  async fetch(
    req: Request,
    env: CronEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/probe" && req.method === "GET") {
      const pageParam = url.searchParams.get("page");
      const page = pageParam ? clampInt(pageParam, 1, 1000) : 1;
      const result = await probeArchivePage(
        env.SOURCE_BASE,
        env.USER_AGENT,
        page,
      );
      return Response.json(result);
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const pagesParam = url.searchParams.get("pages");
      const startPageParam = url.searchParams.get("start_page");
      const enrichLimitParam = url.searchParams.get("enrich_limit");
      const scrapeMaxParam = url.searchParams.get("scrape_max");
      const fromDateParam = url.searchParams.get("from_date");
      const toDateParam = url.searchParams.get("to_date");
      const useSitemapParam = url.searchParams.get("use_sitemap");
      const useHomepageParam = url.searchParams.get("use_homepage");
      const pages = pagesParam ? clampInt(pagesParam, 1, 200) : undefined;
      const startPage = startPageParam
        ? clampInt(startPageParam, 1, 1000)
        : undefined;
      const enrichLimit = enrichLimitParam
        ? clampInt(enrichLimitParam, 0, 500)
        : undefined;
      const scrapeMax = scrapeMaxParam
        ? clampInt(scrapeMaxParam, 1, 500)
        : undefined;
      const fromDate = parseIsoDate(fromDateParam);
      const toDate = parseIsoDate(toDateParam);
      const useSitemap = useSitemapParam === "1" || useSitemapParam === "true";
      const useHomepage =
        useHomepageParam === "1" || useHomepageParam === "true";
      // Backfill runs much longer than the 30s response budget.
      // Detach via waitUntil and acknowledge synchronously.
      if (
        pages ||
        startPage ||
        enrichLimit !== undefined ||
        scrapeMax !== undefined ||
        fromDate ||
        toDate ||
        useSitemap ||
        useHomepage
      ) {
        ctx.waitUntil(
          runPipeline(env, {
            pages,
            startPage,
            enrichLimit,
            scrapeMax,
            fromDate,
            toDate,
            useSitemap,
            useHomepage,
          }),
        );
        return Response.json({
          started: true,
          startPage: startPage ?? 1,
          pages,
          enrichLimit,
          scrapeMax,
          fromDate,
          toDate,
          useSitemap,
          useHomepage,
        });
      }
      const result = await runPipeline(env);
      return Response.json(result);
    }
    if (url.pathname === "/scrape" && req.method === "POST") {
      const articleUrl = url.searchParams.get("url");
      if (!articleUrl)
        return Response.json({ error: "missing ?url=" }, { status: 400 });
      const enrich = url.searchParams.get("enrich") === "1";
      const forceEnrich = url.searchParams.get("force_enrich") === "1";
      const parsed = await fetchAndParse(articleUrl, env.USER_AGENT);
      if (!parsed)
        return Response.json({ error: "parse returned null" }, { status: 422 });
      const bmSrc = await getSourceBySlug(env.DB, "businessmontres");
      const article = { ...parsed, source_id: bmSrc?.id ?? 1 };
      await upsertArticle(env.DB, article);
      let enriched = false;
      if (enrich || forceEnrich) {
        let row = null;
        if (forceEnrich) {
          row = await getArticleByUrl(env.DB, article.url);
        } else {
          const rows = await listUnenriched(env.DB, 50);
          row = rows.find((r) => r.url === article.url) ?? null;
        }
        if (row) {
          await enrichArticle(env, row);
          enriched = true;
        }
      }
      return Response.json({ scraped: article, enriched });
    }
    return new Response("baromontres cron worker", { status: 200 });
  },
};

async function runPipeline(
  env: CronEnv,
  opts: {
    pages?: number;
    startPage?: number;
    enrichLimit?: number;
    scrapeMax?: number;
    fromDate?: string;
    toDate?: string;
    useSitemap?: boolean;
    useHomepage?: boolean;
  } = {},
): Promise<{
  discovered: number;
  scraped: number;
  skippedOutOfRange: number;
  enriched: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const scrapeLimit = Number(env.SCRAPE_LIMIT) || 200;
  const enrichLimit = opts.enrichLimit ?? (Number(env.ENRICH_LIMIT) || 20);
  // Cloudflare subrequest cap per invocation: ~50 default, ~100k max.
  // Each scrape uses 2 subrequests (fetch + D1 upsert), discovery uses
  // pageCount + 1. Default 18 keeps total under 50.
  const scrapeMax = opts.scrapeMax ?? 18;
  const startPage = opts.startPage ?? 1;
  const pageCount = opts.pages ?? (Number(env.LISTING_PAGES) || 4);
  const endPage = startPage + pageCount - 1;
  const fromDate = opts.fromDate;
  const toDate = opts.toDate;

  // Cloudflare's waitUntil budget for fetch handlers is ~30s. Stop cleanly
  // before the runtime kills us so partial work commits and the next call
  // can resume (dedupe handles overlap).
  const BUDGET_MS = 25000;
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > BUDGET_MS;

  const [seen, bmSource] = await Promise.all([
    existingUrls(env.DB),
    getSourceBySlug(env.DB, "businessmontres"),
  ]);
  const defaultSourceId = bmSource?.id ?? 1;
  console.log(
    `pipeline start pages=${startPage}..${endPage} existing=${seen.size} scrapeLimit=${scrapeLimit} enrichLimit=${enrichLimit} from=${fromDate ?? "-"} to=${toDate ?? "-"} useSitemap=${opts.useSitemap ? "1" : "0"} useHomepage=${opts.useHomepage ? "1" : "0"}`,
  );

  let candidates: string[] = [];
  if (opts.useSitemap) {
    const sm = await discoverFromSitemap(env.SOURCE_BASE, env.USER_AGENT);
    if (sm) {
      candidates = sm.urls.slice(0, scrapeLimit);
      console.log(
        `discovery via sitemap (${sm.source}): ${sm.urls.length} urls`,
      );
    } else {
      console.log(`discovery: sitemap unavailable, falling back to archives`);
    }
  }
  if (candidates.length === 0 && opts.useHomepage) {
    candidates = await discoverFromHomepagePages(
      env.SOURCE_BASE,
      env.USER_AGENT,
      scrapeLimit,
      startPage,
      endPage,
    );
    console.log(`discovery via homepage pagination: ${candidates.length} urls`);
  }
  if (candidates.length === 0) {
    candidates = await discoverArticleUrls(
      env.SOURCE_BASE,
      env.USER_AGENT,
      scrapeLimit,
      startPage,
      endPage,
    );
    console.log(`discovery via archives: ${candidates.length} urls`);
  }
  const fresh = candidates.filter((u) => !seen.has(u));
  const toScrape = fresh.slice(0, scrapeMax);
  console.log(
    `discovery: candidates=${candidates.length} fresh=${fresh.length} scraping=${toScrape.length}/${scrapeMax}`,
  );

  // Process the whole fetch→parse→upsert chain concurrently per batch.
  // Fetch is I/O-bound, parse is CPU-bound, upsert is I/O-bound; running
  // them all in parallel pipelines those phases across articles.
  // When from_date / to_date are set, the article is parsed but only
  // upserted if its published_at falls in the range — out-of-range
  // articles are counted as skipped so the operator can see what's
  // happening.
  const BATCH_SIZE = 6;
  let scraped = 0;
  let skippedOutOfRange = 0;
  let oldestSeen: string | null = null;
  const inRange = (d: string | null | undefined): boolean => {
    if (!d) return true; // unparseable date — let upsert decide; do not silently drop
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };
  outer: for (let i = 0; i < toScrape.length; i += BATCH_SIZE) {
    if (budgetExceeded()) {
      console.log(
        `scrape phase: time budget reached at ${scraped}/${toScrape.length}`,
      );
      break;
    }
    const batch = toScrape.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        const parsed = await fetchAndParse(url, env.USER_AGENT);
        if (!parsed) return { url, kind: "null" as const };
        if (!inRange(parsed.published_at)) {
          return {
            url,
            kind: "out_of_range" as const,
            published_at: parsed.published_at,
          };
        }
        const article = { ...parsed, source_id: defaultSourceId };
        await upsertArticle(env.DB, article);
        return { url, kind: "ok" as const, published_at: article.published_at };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const url = batch[j]!;
      const r = settled[j]!;
      if (r.status === "rejected") {
        const msg = stringifyError(r.reason);
        console.error(`scrape failed: ${url} :: ${msg}`);
        errors.push(`scrape ${url}: ${msg}`);
        continue;
      }
      if (r.value.kind === "null") {
        console.warn(`scrape skipped (parse returned null): ${url}`);
        continue;
      }
      if (r.value.kind === "out_of_range") {
        skippedOutOfRange += 1;
        const pa = r.value.published_at;
        if (pa && (oldestSeen === null || pa < oldestSeen)) oldestSeen = pa;
        continue;
      }
      scraped += 1;
      const pa = r.value.published_at;
      if (pa && (oldestSeen === null || pa < oldestSeen)) oldestSeen = pa;
    }
    // Stop walking pages once we've gone below the lower bound.
    if (fromDate && oldestSeen && oldestSeen < fromDate) {
      console.log(
        `scrape phase: from_date=${fromDate} reached (oldest=${oldestSeen})`,
      );
      break outer;
    }
  }
  console.log(
    `scrape phase done: scraped=${scraped} out_of_range=${skippedOutOfRange} total=${toScrape.length} oldest=${oldestSeen ?? "-"}`,
  );

  let enriched = 0;
  if (enrichLimit > 0 && !budgetExceeded()) {
    const pending = await listUnenriched(env.DB, enrichLimit);
    console.log(
      `enrich phase: pending=${pending.length} (limit=${enrichLimit})`,
    );
    for (const row of pending) {
      if (budgetExceeded()) {
        console.log(
          `enrich phase: time budget reached at ${enriched}/${pending.length}`,
        );
        break;
      }
      try {
        await enrichArticle(env, row);
        enriched += 1;
      } catch (err) {
        const msg = stringifyError(err);
        console.error(`enrich failed: ${row.url} :: ${msg}`);
        errors.push(`enrich ${row.url}: ${msg}`);
      }
    }
  } else if (enrichLimit === 0) {
    console.log(`enrich phase: skipped (enrich_limit=0)`);
  } else {
    console.log(`enrich phase: skipped (no time budget remaining)`);
  }
  console.log(
    `pipeline done: discovered=${candidates.length} scraped=${scraped} out_of_range=${skippedOutOfRange} enriched=${enriched} errors=${errors.length}`,
  );

  return {
    discovered: candidates.length,
    scraped,
    skippedOutOfRange,
    enriched,
    errors,
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function parseIsoDate(raw: string | null): string | undefined {
  if (!raw) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}
