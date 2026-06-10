import { createApi } from '@baromontres/shared/api';
import type { Env } from '@baromontres/shared/schema';

const api = createApi();

export interface WorkerEnv extends Env {
  ASSETS: Fetcher;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // Allow AdSense (active on /en), self, and inline styles (used by chart.js canvas).
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://pagead2.googlesyndication.com",
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
};

function addSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return addSecurityHeaders(await api.fetch(request, env, ctx));
    }
    return addSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
