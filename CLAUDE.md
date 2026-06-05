# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Before every `git commit`

Run both checks and **do not commit if either fails**:

```bash
pnpm test    # unit tests — all must pass
pnpm build   # build web assets + typecheck — zero errors
```

## Before deploying the web worker

Always rebuild assets first:

```bash
cd apps/web && npm run build
cd ../..
wrangler deploy
```

Never run `wrangler deploy` at the root without rebuilding first.

## After every deploy

**Web worker** — curl these three endpoints; all must return HTTP 200 with non-empty JSON:

```bash
curl -sf https://baromontres.onepau.workers.dev/api/health
curl -sf "https://baromontres.onepau.workers.dev/api/barometer?limit=1"
curl -sf https://baromontres.onepau.workers.dev/api/images/flagged
```

**Cron worker** — must return 200:

```bash
curl -sf https://baromontres-cron.onepau.workers.dev/
```

If any check fails, investigate and fix before pushing.

## Commands

```bash
pnpm test                          # run all tests (vitest, workspace-wide)
pnpm build                         # build web assets via Vite
pnpm dev:web                       # Vite dev server for the frontend
pnpm dev:cron                      # wrangler dev with --test-scheduled (cron simulation)
pnpm deploy:web                    # build + deploy web worker
pnpm deploy:cron                   # deploy cron worker

# Run a single test file
pnpm --filter @baromontres/cron test -- tests/scrape.test.ts

# Deploy cron worker directly (from repo root)
cd apps/cron && wrangler deploy

# Stream live cron worker logs
wrangler tail baromontres-cron --format pretty

# Run a raw SQL query against the remote D1 database
wrangler d1 execute baromontres --remote --command "SELECT COUNT(*) FROM article"
```

No linter is configured (no ESLint, Biome, or Prettier).

## Architecture

### Monorepo layout

```
apps/web/        — Cloudflare Worker (baromontres) serving the SPA + JSON API
apps/cron/       — Cloudflare Worker (baromontres-cron) for scraping & enrichment
packages/shared/ — D1 schema types, all SQL queries, Hono API routes (shared by both workers)
migrations/      — Forward-only SQL migrations (0001_init → 0004_seed_sources)
```

### Two workers, one D1 database

Both workers bind to the same D1 database (`baromontres`). The web worker serves the frontend SPA (from `apps/web/dist/`) and mounts the shared Hono app for all `/api/*` routes. The cron worker owns the data pipeline — scraping, parsing, and enrichment — and also exposes HTTP endpoints for manual backfill operations.

### packages/shared is the source of truth

All SQL queries live in `packages/shared/src/queries.ts`. All Hono API route definitions live in `packages/shared/src/api.ts`. Schema types (table row shapes, `Env` interface) are in `packages/shared/src/schema.ts`. Both workers import from here; never duplicate query logic in app-level code.

### Cron worker pipeline (`apps/cron/src/`)

- `index.ts` — `scheduled` handler (daily 04:17 UTC) + HTTP endpoints:
  - `POST /run` — full scrape+enrich pipeline with budget management
  - `POST /enrich` — self-chaining enrichment drain (calls itself until all articles are enriched)
  - `POST /scrape` — single article scrape + optional enrichment
  - `GET /probe` — read-only archive page inspection
- `scrape.ts` — fetches and parses article HTML; discovers URLs from archives, sitemap, homepage
- `enrich.ts` — text enrichment (Claude Haiku via Anthropic API) + image enrichment (Google Vision WEB_DETECTION → Claude Haiku fallback); `enrichArticle()` is the entry point
- `adapters.ts` — per-source RSS/HTML adapters for multi-publication discovery
- `prompts.ts` — cached system prompts for Claude (text and image enrichment)

**Time-budget pattern**: `runPipeline()` sets a 25 s wall-clock budget (`BUDGET_MS = 25_000`) and checks `budgetExceeded()` before each batch and before each article. Work commits incrementally; the next invocation dedupes via `existingUrls()`. The `/enrich` endpoint avoids this limit entirely by self-chaining: each invocation enriches one batch then fires `fetch(selfUrl)` to start a fresh invocation.

### Enrichment pipeline detail

`enrichArticle()` runs two branches then calls `persistEnrichment()`:

1. **Text** — Claude Haiku produces `{sentiment, keywords}` JSON for the article title + body
2. **Image** — Google Vision `WEB_DETECTION` is tried first:
   - Vision web entities or `bestGuessLabel` match `WATCH_TERMS` → `not_watch_image: false`, no Claude call
   - Vision matches `CARTOON_ENTITY_MAP` (checked against `webEntities` and `bestGuessLabel` only, not `sourcePageUrls`) → `not_watch_image: true`, no Claude call
   - Otherwise → Claude Haiku sees the image and article title, returns `{not_watch_image, has_text_overlay, ai_generated_likelihood}`

### D1 schema (key tables)

| Table            | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `article`        | One row per URL; `enriched_at` NULL = not yet enriched           |
| `sentiment`      | label / score / rationale per article                            |
| `keyword`        | 3–12 terms per article; kind ∈ brand/topic/person/model          |
| `image_analysis` | Hero image flags (watch/cartoon/AI/overlay) per article          |
| `source`         | Publication registry; `active=1` sources are scraped by the cron |

`listUnenriched()` always queries `ORDER BY published_at DESC` — enrichment processes newest articles first.

### Frontend (`apps/web/src/`)

Single-page app in vanilla TypeScript (no framework). `main.ts` is the entire client — it fetches from `/api/*` and renders directly into the DOM. `api.ts` holds all typed fetch wrappers. The app has FR and EN routes (`/` and `/en/`) via separate `index.html` files built by Vite. `worker.ts` is the Cloudflare Worker entry point that mounts the shared Hono app and falls back to static asset serving.
