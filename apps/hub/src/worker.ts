// Apex hub Worker for tick-ticker.com.
//
// The apex used to serve the public barometer SPA (the old `baromontres` web
// worker). That app has been retired from public view and relocated behind
// Cloudflare Access; this worker replaces it with a small static hub that links
// to gphg.tick-ticker.com and blog.tick-ticker.com.
//
// Everything is served as a static asset except the retired barometer surface:
// the public JSON API under /api/* and the barometer-only /llms.txt now return
// HTTP 410 Gone with X-Robots-Tag: noindex. A 410 is an unambiguous "permanently
// gone" signal that Google acts on faster than a 404, and these endpoints had no
// accumulated ranking equity worth preserving. The header is set here at the
// Worker level rather than via <meta>, because a directive inside markup cannot
// be attached to a non-HTML JSON response and is unreliable for crawlers anyway.

export interface Env {
  ASSETS: Fetcher;
}

// Retired barometer surface. `/api` and anything under `/api/`, plus the
// barometer's llms.txt. The hub's own files (/, robots.txt, sitemap.xml,
// ga4.js) are served normally.
function isRetired(pathname: string): boolean {
  if (pathname === "/llms.txt") return true;
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  return false;
}

// The hub is English-only. `/en` and `/en/` were the old bilingual apex's
// English path (indexed under the retired barometer); redirect them to the
// single canonical home so that URL's equity consolidates onto `/`.
function isLegacyEnglishPath(pathname: string): boolean {
  return pathname === "/en" || pathname === "/en/";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isLegacyEnglishPath(url.pathname)) {
      return Response.redirect(new URL("/", url).toString(), 301);
    }

    if (isRetired(url.pathname)) {
      return new Response(
        "410 Gone\n\nThe public tick-ticker barometer has been retired.\nSee https://tick-ticker.com/ for the GPHG price index and the blog.\n",
        {
          status: 410,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-robots-tag": "noindex",
            "cache-control": "no-store",
          },
        },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
