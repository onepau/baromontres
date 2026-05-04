import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getArticleDetail,
  getBarometer,
  getFlaggedImages,
  getKeywordFrequencies,
  latestSubscriptionPrice,
} from './queries.ts';
import type { Env, KeywordKind } from './schema.ts';

const KEYWORD_KINDS: ReadonlySet<KeywordKind> = new Set([
  'brand',
  'topic',
  'person',
  'model',
]);

export function createApi(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', cors({ origin: '*', allowMethods: ['GET'] }));

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/barometer', async (c) => {
    const since = c.req.query('since') ?? undefined;
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Math.min(5000, Math.max(1, Number(limitParam))) : undefined;
    const [points, subscription] = await Promise.all([
      getBarometer(c.env.DB, { since, limit }),
      latestSubscriptionPrice(c.env.DB),
    ]);
    return c.json({ points, subscription });
  });

  app.get('/api/article/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const detail = await getArticleDetail(c.env.DB, id);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.get('/api/keywords', async (c) => {
    const kindParam = c.req.query('kind');
    const limitParam = c.req.query('limit');
    const minCountParam = c.req.query('min_count');
    const kind =
      kindParam && KEYWORD_KINDS.has(kindParam as KeywordKind)
        ? (kindParam as KeywordKind)
        : undefined;
    const limit = limitParam ? Math.min(500, Math.max(1, Number(limitParam))) : undefined;
    const min_count = minCountParam
      ? Math.min(50, Math.max(1, Number(minCountParam) || 1))
      : undefined;
    const frequencies = await getKeywordFrequencies(c.env.DB, { kind, limit, min_count });
    return c.json({ frequencies });
  });

  app.get('/api/images/flagged', async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Math.min(50, Math.max(1, Number(limitParam) || 12)) : undefined;
    const flags = await getFlaggedImages(c.env.DB, { limit });
    return c.json({ flags });
  });

  return app;
}
