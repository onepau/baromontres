import type { Env } from '@baromontres/shared/schema';
import { listUnenriched, upsertArticle, existingUrls } from '@baromontres/shared/queries';
import {
  discoverArticleUrls,
  discoverFromSitemap,
  fetchAndParse,
  probeArchivePage,
} from './scrape.ts';
import { enrichArticle } from './enrich.ts';

// How to backfill (operator recipe):
//   # 1. See what we have, by month:
//   curl https://baromontres-api.<acc>.workers.dev/api/diag/articles_by_month | jq
//
//   # 2. See what's actually on archive page N (read-only, no DB write):
//   curl https://baromontres-cron.<acc>.workers.dev/probe?page=12 | jq
//
//   # 3. Fill the gap by date instead of guessing page numbers:
//   curl -X POST 'https://baromontres-cron.<acc>.workers.dev/run?start_page=1&pages=50&until_date=2025-05-01&enrich_limit=0'
//
//   # 4. Drain enrichment afterwards:
//   curl -X POST 'https://baromontres-cron.<acc>.workers.dev/run?enrich_limit=20'

interface CronEnv extends Env {
  SCRAPE_LIMIT: string;
  ENRICH_LIMIT: string;
  LISTING_PAGES: string;
  USER_AGENT: string;
  SOURCE_BASE: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
  async fetch(req: Request, env: CronEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/probe' && req.method === 'GET') {
      const pageParam = url.searchParams.get('page');
      const page = pageParam ? clampInt(pageParam, 1, 1000) : 1;
      const result = await probeArchivePage(env.SOURCE_BASE, env.USER_AGENT, page);
      return Response.json(result);
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      const pagesParam = url.searchParams.get('pages');
      const startPageParam = url.searchParams.get('start_page');
      const enrichLimitParam = url.searchParams.get('enrich_limit');
      const scrapeMaxParam = url.searchParams.get('scrape_max');
      const untilDateParam = url.searchParams.get('until_date');
      const useSitemapParam = url.searchParams.get('use_sitemap');
      const pages = pagesParam ? clampInt(pagesParam, 1, 100) : undefined;
      const startPage = startPageParam ? clampInt(startPageParam, 1, 1000) : undefined;
      const enrichLimit = enrichLimitParam ? clampInt(enrichLimitParam, 0, 500) : undefined;
      const scrapeMax = scrapeMaxParam ? clampInt(scrapeMaxParam, 1, 500) : undefined;
      const untilDate = untilDateParam && /^\d{4}-\d{2}-\d{2}$/.test(untilDateParam)
        ? untilDateParam
        : undefined;
      const useSitemap = useSitemapParam === '1' || useSitemapParam === 'true';
      // Backfill runs much longer than the 30s response budget.
      // Detach via waitUntil and acknowledge synchronously.
      if (
        pages ||
        startPage ||
        enrichLimit !== undefined ||
        scrapeMax !== undefined ||
        untilDate ||
        useSitemap
      ) {
        ctx.waitUntil(
          runPipeline(env, { pages, startPage, enrichLimit, scrapeMax, untilDate, useSitemap }),
        );
        return Response.json({
          started: true,
          startPage: startPage ?? 1,
          pages,
          enrichLimit,
          scrapeMax,
          untilDate,
          useSitemap,
        });
      }
      const result = await runPipeline(env);
      return Response.json(result);
    }
    return new Response('baromontres cron worker', { status: 200 });
  },
};

async function runPipeline(
  env: CronEnv,
  opts: {
    pages?: number;
    startPage?: number;
    enrichLimit?: number;
    scrapeMax?: number;
    untilDate?: string;
    useSitemap?: boolean;
  } = {},
): Promise<{
  discovered: number;
  scraped: number;
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
  const untilDate = opts.untilDate;

  // Cloudflare's waitUntil budget for fetch handlers is ~30s. Stop cleanly
  // before the runtime kills us so partial work commits and the next call
  // can resume (dedupe handles overlap).
  const BUDGET_MS = 25000;
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > BUDGET_MS;

  const seen = await existingUrls(env.DB);
  console.log(
    `pipeline start pages=${startPage}..${endPage} existing=${seen.size} scrapeLimit=${scrapeLimit} enrichLimit=${enrichLimit} untilDate=${untilDate ?? '-'} useSitemap=${opts.useSitemap ? '1' : '0'}`,
  );

  let candidates: string[] = [];
  if (opts.useSitemap) {
    const sm = await discoverFromSitemap(env.SOURCE_BASE, env.USER_AGENT);
    if (sm) {
      candidates = sm.urls.slice(0, scrapeLimit);
      console.log(`discovery via sitemap (${sm.source}): ${sm.urls.length} urls`);
    } else {
      console.log(`discovery: sitemap unavailable, falling back to archives`);
    }
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
  const BATCH_SIZE = 6;
  let scraped = 0;
  let oldestSeen: string | null = null;
  outer: for (let i = 0; i < toScrape.length; i += BATCH_SIZE) {
    if (budgetExceeded()) {
      console.log(`scrape phase: time budget reached at ${scraped}/${toScrape.length}`);
      break;
    }
    const batch = toScrape.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        const article = await fetchAndParse(url, env.USER_AGENT);
        if (!article) return { url, kind: 'null' as const };
        await upsertArticle(env.DB, article);
        return { url, kind: 'ok' as const, published_at: article.published_at };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const url = batch[j]!;
      const r = settled[j]!;
      if (r.status === 'rejected') {
        const msg = stringifyError(r.reason);
        console.error(`scrape failed: ${url} :: ${msg}`);
        errors.push(`scrape ${url}: ${msg}`);
        continue;
      }
      if (r.value.kind === 'null') {
        console.warn(`scrape skipped (parse returned null): ${url}`);
        continue;
      }
      scraped += 1;
      const pa = r.value.published_at;
      if (pa && (oldestSeen === null || pa < oldestSeen)) oldestSeen = pa;
    }
    if (untilDate && oldestSeen && oldestSeen < untilDate) {
      console.log(`scrape phase: until_date=${untilDate} reached (oldest=${oldestSeen})`);
      break outer;
    }
  }
  console.log(`scrape phase done: scraped=${scraped}/${toScrape.length} oldest=${oldestSeen ?? '-'}`);

  let enriched = 0;
  if (enrichLimit > 0 && !budgetExceeded()) {
    const pending = await listUnenriched(env.DB, enrichLimit);
    console.log(`enrich phase: pending=${pending.length} (limit=${enrichLimit})`);
    for (const row of pending) {
      if (budgetExceeded()) {
        console.log(`enrich phase: time budget reached at ${enriched}/${pending.length}`);
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
    `pipeline done: discovered=${candidates.length} scraped=${scraped} enriched=${enriched} errors=${errors.length}`,
  );

  return { discovered: candidates.length, scraped, enriched, errors };
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
