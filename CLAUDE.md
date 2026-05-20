# Baromontres — Claude working instructions

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
