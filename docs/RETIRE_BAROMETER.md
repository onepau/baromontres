# Retiring the public barometer, protecting the subdomains

Runbook for moving `tick-ticker.com` (the apex) from the public barometer to a
small hub, and relocating the barometer behind Cloudflare Access. Companion to
the branch `retire-public-barometer`.

This is a **deployment and routing change, not a teardown**. The barometer app,
its D1 database, the scrapers and the daily cron all keep running — the data
pipeline still feeds blog content. Nothing here deletes application code or data.

## What changed in the repo

| Area                                           | Before                                                               | After                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apex `tick-ticker.com`                         | `baromontres` web worker serving the barometer SPA + public `/api/*` | New `tick-ticker-hub` worker: static English hub at `/` (old `/en/` → **301** `/`), **410 + noindex** for `/api/*` and `/llms.txt`                           |
| Barometer app (`apps/web` → `baromontres`)     | Public at the apex                                                   | Same code, now stamped `X-Robots-Tag: noindex, nofollow` on every response and `robots.txt: Disallow: /`, for a **protected** workers.dev host behind Access |
| Cron worker (`apps/cron` → `baromontres-cron`) | Daily scrape+enrich, binds D1 directly                               | **Unchanged** — pipeline keeps running                                                                                                                       |
| D1 (`baromontres`)                             | —                                                                    | **Unchanged** — same database, same bindings                                                                                                                 |

New files: `apps/hub/**`. Modified: `apps/web/src/worker.ts`, `apps/web/public/robots.txt`.

## Why the apex is a "replace", not a "410"

The apex root **is** the barometer homepage — the only indexed apex URLs are `/`
and `/en/` (the whole SPA). There is no set of separate barometer routes to 410
next to a surviving hub. So the safe move is to **replace** the SPA at `/` with the
hub (which stays 200 and indexable) and reserve 410 + noindex for the barometer's
distinct public surface: the JSON API `/api/*` and `/llms.txt`. The hub is
English-only, so the old English path `/en/` **301-redirects to `/`**, consolidating
that URL's equity onto the single home.

`robots.txt` `Disallow` for those paths is deliberately **not** added on the apex:
Disallow blocks crawling, and a path that cannot be crawled cannot be seen to
carry the 410/noindex, so it lingers as a URL-only index entry. Robots rules come
last, if at all (see GSC steps).

## Cutover — order matters. Do not deploy without confirming.

A hostname binds to exactly one Worker, so the apex must be handed from
`baromontres` to `tick-ticker-hub` in one deliberate sequence.

1. **Deploy the hub to its workers.dev host first** (route still commented out in
   `apps/hub/wrangler.toml`):

   ```bash
   cd apps/hub && wrangler deploy
   ```

   Verify on the `*.workers.dev` URL: `/` returns 200 HTML, `/en/` → 301 `/`; `/api/health`
   and `/api/barometer` return 410 with `x-robots-tag: noindex`; `/robots.txt` and
   `/sitemap.xml` serve.

2. **Remove the `tick-ticker.com` custom domain from the `baromontres` worker** in
   the Cloudflare dashboard (Workers & Pages → baromontres → Settings → Domains &
   Routes). The barometer falls back to `baromontres.onepau.workers.dev`.

3. **Claim the apex for the hub**: uncomment the `routes` block in
   `apps/hub/wrangler.toml`, then:

   ```bash
   cd apps/hub && wrangler deploy
   ```

   Verify `https://tick-ticker.com/` → 200 hub, `/en/` → 301 `/`, `/api/health` → 410.

4. **Redeploy the now-protected barometer** so the noindex header and Disallow
   ship on its workers.dev host:

   ```bash
   cd apps/web && npm run build && cd ../.. && wrangler deploy
   ```

5. **Put Cloudflare Access in front of the barometer** (`baromontres.onepau.workers.dev`):
   Zero Trust → Access → Applications → add a self-hosted app for that hostname,
   policy = the one operator email. Confirm the free plan's user cap still covers
   this — the project takes on **no paid subscription**. The noindex header + robots
   Disallow from step 4 cover the window before Access is fully applied.

The cron worker needs no redeploy; it never depended on the apex binding.

## Search Console (after the 410s are live)

- Submit the regenerated apex sitemap (`https://tick-ticker.com/sitemap.xml`) in the
  **apex** property.
- Use the **Removals** tool on the apex property to temporarily suppress the
  barometer URL patterns (`/api/*`, `/llms.txt`) — hides them within ~a day while
  the 410s process; lasts ~6 months.
- Resubmit the `gphg` and `blog` sitemaps to confirm both are healthy.
- Monitor the apex Pages report weekly; expect the barometer URLs to drop over 2–6
  weeks. Only once they are gone is a `robots.txt` `Disallow` worth adding, and by
  then it is cosmetic.

These steps need the operator's Google Search Console access and are not automatable
from the repo.

## Verification checklist (Phase 7)

- [ ] Apex `/` → 200, indexable (no `x-robots-tag` noindex), English hub content; `/en/` → 301 `/`.
- [ ] Apex `/api/health`, `/api/barometer`, `/llms.txt` → 410 with `x-robots-tag: noindex`.
- [ ] Apex sitemap contains only `/`; no barometer/API entries.
- [ ] `gphg.tick-ticker.com` and `blog.tick-ticker.com` sitemaps unchanged and valid.
- [ ] Barometer host unreachable without Access; serves `x-robots-tag: noindex` and `Disallow: /`.
- [ ] `baromontres-cron` still runs; D1 still receiving rows (`wrangler d1 execute baromontres --remote --command "SELECT COUNT(*) FROM article"`).
- [ ] Analytics recording on the new apex hub (GA4 realtime + Clarity).

## Out of scope / handled elsewhere

- **Cross-repo internal links** — blog posts on `blog.tick-ticker.com` and the GPHG
  index that link to apex barometer/API URLs live in other repositories and are being
  rewritten by the operator, not in this repo.
- **Subdomain consolidation** (`gphg`/`blog` → subdirectories of the apex) is
  deliberately **deferred to December/January**, after the 7 November GPHG ceremony —
  it causes a temporary ranking dip and must not run during the peak window.
- **Stray Monetag service-worker files** (`apps/web/sw.js`, `apps/web/src/sw.js`,
  loading `5gvci.com`, from commit `b92c720`) were unreferenced and never shipped to
  `dist/`; **removed** in this branch now that the barometer is off the public apex.
