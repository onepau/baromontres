# Baromontres

Bilingual (FR/EN) price-and-mood barometer for
[businessmontres.com](https://www.businessmontres.com).

A scheduled Cloudflare Worker scrapes the public listing, stores articles in
D1, and enriches each one with **sentiment**, **brand/topic keywords**, and
**image analysis** (doctored comic-book art, AI-generation likelihood) using
the Anthropic API. A Cloudflare Pages frontend renders a Chart.js barometer
where every dot is one article, colored by sentiment, and the hover tooltip
links back to the source.

## Stack

- **Frontend** — Cloudflare Pages, vanilla TypeScript, Chart.js v4, no SPA framework.
- **API** — Pages Functions delegating to a [Hono](https://hono.dev) router (see `packages/shared/src/api.ts`).
- **Cron** — separate Cloudflare Worker on a daily schedule (`apps/cron`).
- **Database** — Cloudflare D1 (SQLite). Schema in `migrations/0001_init.sql`.
- **Enrichment** — Claude Haiku 4.5 (multimodal) via `fetch`, with prompt-cached system blocks.

## Layout

```
apps/
  web/       Pages site (Vite + TS + Chart.js) + Pages Functions for /api/*
  cron/      Scheduled Worker: discover → scrape → enrich
packages/
  shared/    D1 schema types, queries, Hono API routes
migrations/  D1 SQL migrations
```

## One-time setup

```sh
pnpm install
wrangler login
wrangler d1 create baromontres
# copy the printed database_id into apps/web/wrangler.toml and apps/cron/wrangler.toml
pnpm db:init:remote
wrangler secret put ANTHROPIC_API_KEY --config apps/cron/wrangler.toml
```

## Local development

```sh
pnpm db:init:local
pnpm dev:cron     # scheduled worker on http://127.0.0.1:8787
pnpm dev:web      # Vite proxying /api → 8787, http://127.0.0.1:5173
```

Trigger one scheduled run locally:

```sh
curl -X POST http://127.0.0.1:8787/run
```

## Deploy

```sh
pnpm deploy:cron
pnpm deploy:web
```

## Google Ads

`apps/web/src/index.html` reserves a placeholder `<aside id="ad-slot-home">`
between the chart and the topics section, with a stubbed AdSense `<ins>` tag.
To go live: replace `data-ad-client` and `data-ad-slot` with your IDs and
uncomment the AdSense `<script>` snippet in the same file.

## Tests

```sh
pnpm test
```

Parser tests in `apps/cron/tests/` run against committed HTML fixtures (one
paid article, one free article).

## Backfill

The daily cron walks `LISTING_PAGES` (default 4) listing pages — enough to
catch new posts without hammering the source. To backfill ~12 months in one
pass, POST `/run?pages=N`:

```sh
curl -X POST "https://baromontres-cron.<sub>.workers.dev/run?pages=40"
```

Discovery stops early when a page yields no new URLs or returns 404, so an
oversized `pages` value is safe. Each listing fetch sleeps ~700 ms.
Enrichment then catches up over subsequent daily runs (or POST `/run` again
to accelerate).

## Notes

- The 2017 Python/Flask code (and the empty MySQL archive that lived
  alongside it) was removed in this rewrite. Article data is rebuilt from
  the live site.
- The old hardcoded MySQL password committed in 2017 should be rotated if
  it is reused anywhere; it does not appear in the new codebase.
