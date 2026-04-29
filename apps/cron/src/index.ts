import type { Env } from '@baromontres/shared/schema';
import { listUnenriched, upsertArticle, existingUrls } from '@baromontres/shared/queries';
import { discoverArticleUrls, fetchAndParse } from './scrape.ts';
import { enrichArticle } from './enrich.ts';

interface CronEnv extends Env {
  SCRAPE_LIMIT: string;
  ENRICH_LIMIT: string;
  USER_AGENT: string;
  SOURCE_BASE: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
  async fetch(req: Request, env: CronEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      const result = await runPipeline(env);
      return Response.json(result);
    }
    return new Response('baromontres cron worker', { status: 200 });
  },
};

async function runPipeline(env: CronEnv): Promise<{
  discovered: number;
  scraped: number;
  enriched: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const scrapeLimit = Number(env.SCRAPE_LIMIT) || 200;
  const enrichLimit = Number(env.ENRICH_LIMIT) || 20;

  const seen = await existingUrls(env.DB);
  const candidates = await discoverArticleUrls(env.SOURCE_BASE, env.USER_AGENT, scrapeLimit);
  const fresh = candidates.filter((u) => !seen.has(u));

  let scraped = 0;
  for (const url of fresh) {
    try {
      const article = await fetchAndParse(url, env.USER_AGENT);
      if (!article) continue;
      await upsertArticle(env.DB, article);
      scraped += 1;
      await sleep(1000);
    } catch (err) {
      errors.push(`scrape ${url}: ${stringifyError(err)}`);
    }
  }

  const pending = await listUnenriched(env.DB, enrichLimit);
  let enriched = 0;
  for (const row of pending) {
    try {
      await enrichArticle(env, row);
      enriched += 1;
    } catch (err) {
      errors.push(`enrich ${row.url}: ${stringifyError(err)}`);
    }
  }

  return { discovered: candidates.length, scraped, enriched, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
