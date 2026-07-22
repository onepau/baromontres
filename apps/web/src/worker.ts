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

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (isCacheableRequest(request.method, url.pathname)) {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await api.fetch(request, env, ctx);
      if (response.ok) {
        ctx.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    }

    return api.fetch(request, env, ctx);
  },
};
