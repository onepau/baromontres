import { createApi } from "@baromontres/shared/api";
import type { Env } from "@baromontres/shared/schema";

const api = createApi();

export interface WorkerEnv extends Env {
  ASSETS: Fetcher;
}

// Routes to cache at the CF edge using caches.default.
// Keyed by full URL (including query params), TTL driven by Cache-Control s-maxage.
const EDGE_CACHED_PREFIXES = ["/api/barometer"];

function isCacheableRequest(method: string, pathname: string): boolean {
  return (
    method === "GET" &&
    EDGE_CACHED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "?"),
    )
  );
}

// This worker is the barometer app on its PROTECTED deployment (workers.dev,
// behind Cloudflare Access) — it is no longer the public apex. Stamp every
// response with a noindex directive so that if a preview hostname is ever
// discovered before Access is in place, nothing here enters a search index. The
// public hub at tick-ticker.com is served by the separate `tick-ticker-hub`
// worker; see docs/RETIRE_BAROMETER.md.
//
// NOTE: because this deindexes everything it serves, this build must only be
// deployed to the protected host, never to the tick-ticker.com apex.
function withNoindex(response: Response): Response {
  const r = new Response(response.body, response);
  r.headers.set("X-Robots-Tag", "noindex, nofollow");
  return r;
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const response = await env.ASSETS.fetch(request);
      // Content-hashed assets are safe to cache indefinitely in browsers and
      // at the CF edge — the filename changes on every rebuild.
      if (url.pathname.startsWith("/assets/") && response.ok) {
        const r = new Response(response.body, response);
        r.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return withNoindex(r);
      }
      return withNoindex(response);
    }

    if (isCacheableRequest(request.method, url.pathname)) {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return withNoindex(cached);

      const response = await api.fetch(request, env, ctx);
      if (response.ok) {
        ctx.waitUntil(cache.put(request, response.clone()));
      }
      return withNoindex(response);
    }

    return withNoindex(await api.fetch(request, env, ctx));
  },
};
