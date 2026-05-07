import type { Env } from '@baromontres/shared/schema';
import { listUnenriched, upsertArticle, existingUrls } from '@baromontres/shared/queries';
import { discoverArticleUrls, fetchAndParse } from './scrape.ts';
import { enrichArticle } from './enrich.ts';

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
    if (url.pathname === '/run' && req.method === 'POST') {
      const pagesParam = url.searchParams.get('pages');
      const startPageParam = url.searchParams.get('start_page');
      const enrichLimitParam = url.searchParams.get('enrich_limit');
      const pages = pagesParam ? clampInt(pagesParam, 1, 100) : undefined;
      const startPage = startPageParam ? clampInt(startPageParam, 1, 100) : undefined;
      const enrichLimit = enrichLimitParam ? clampInt(enrichLimitParam, 0, 500) : undefined;
      // Backfill runs much longer than the 30s response budget.
      // Detach via waitUntil and acknowledge synchronously.
      if (pages || startPage || enrichLimit !== undefined) {
        ctx.waitUntil(runPipeline(env, { pages, startPage, enrichLimit }));
        return Response.json({ started: true, startPage: startPage ?? 1, pages, enrichLimit });
      }
      const result = await runPipeline(env);
      return Response.json(result);
    }
    return new Response('baromontres cron worker', { status: 200 });
  },
};

async function runPipeline(
  env: CronEnv,
  opts: { pages?: number; startPage?: number; enrichLimit?: number } = {},
): Promise<{
  discovered: number;
  scraped: number;
  enriched: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const scrapeLimit = Number(env.SCRAPE_LIMIT) || 200;
  const enrichLimit = opts.enrichLimit ?? (Number(env.ENRICH_LIMIT) || 20);
  const startPage = opts.startPage ?? 1;
  const pageCount = opts.pages ?? (Number(env.LISTING_PAGES) || 4);
  const endPage = startPage + pageCount - 1;

  // Cloudflare's waitUntil budget for fetch handlers is ~30s. Stop cleanly
  // before the runtime kills us so partial work commits and the next call
  // can resume (dedupe handles overlap).
  const BUDGET_MS = 25000;
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > BUDGET_MS;

  const seen = await existingUrls(env.DB);
  console.log(
    `pipeline start pages=${startPage}..${endPage} existing=${seen.size} scrapeLimit=${scrapeLimit} enrichLimit=${enrichLimit}`,
  );
  const candidates = await discoverArticleUrls(
    env.SOURCE_BASE,
    env.USER_AGENT,
    scrapeLimit,
    startPage,
    endPage,
  );
  const fresh = candidates.filter((u) => !seen.has(u));
  console.log(`discovery: candidates=${candidates.length} fresh=${fresh.length}`);

  // Process the whole fetch→parse→upsert chain concurrently per batch.
  // Fetch is I/O-bound, parse is CPU-bound, upsert is I/O-bound; running
  // them all in parallel pipelines those phases across articles.
  const BATCH_SIZE = 8;
  let scraped = 0;
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    if (budgetExceeded()) {
      console.log(`scrape phase: time budget reached at ${scraped}/${fresh.length}`);
      break;
    }
    const batch = fresh.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        const article = await fetchAndParse(url, env.USER_AGENT);
        if (!article) return { url, kind: 'null' as const };
        await upsertArticle(env.DB, article);
        return { url, kind: 'ok' as const };
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
    }
  }
  console.log(`scrape phase done: scraped=${scraped}/${fresh.length}`);

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
