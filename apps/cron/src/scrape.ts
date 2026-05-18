import { parseHTML } from "linkedom";
import type { ScrapedArticle } from "@baromontres/shared/queries";

// Article URL prefixes we accept during discovery. Enable additional
// entries here once the /probe endpoint confirms the site uses them.
const ARTICLE_PATH_PATTERNS: RegExp[] = [
  /\/article\//i,
  // /\/dossier\//i,
  // /\/test\//i,
  // /\/breve\//i,
  // /\/news\//i,
  // /\/marque\//i,
];

const ARTICLE_HREF = new RegExp(
  `https?:\\/\\/(www\\.)?businessmontres\\.com(${ARTICLE_PATH_PATTERNS.map((r) => r.source).join("|")})`,
  "i",
);
const STUB_URL = /\/article\/default$/i;

export function isArticleUrl(href: string): boolean {
  return ARTICLE_HREF.test(href) && !STUB_URL.test(href);
}

export async function discoverFromHomepagePages(
  sourceBase: string,
  userAgent: string,
  limit: number,
  startPage = 1,
  endPage = 10,
): Promise<string[]> {
  const pageNumbers: number[] = [];
  for (let n = startPage; n <= endPage; n++) pageNumbers.push(n);

  const results = await Promise.allSettled(
    pageNumbers.map((n) => {
      const url = n === 1 ? sourceBase : `${sourceBase}/?page=${n}`;
      return fetchText(url, userAgent);
    }),
  );

  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === "rejected") continue;
    if (seen.size >= limit) break;
    const { document } = parseHTML(r.value);
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (a as Element).getAttribute("href");
      if (!href) continue;
      if (!isArticleUrl(href)) continue;
      const normalized = normalizeUrl(href);
      seen.add(normalized);
      if (seen.size >= limit) break;
    }
  }
  return [...seen];
}

export async function discoverArticleUrls(
  sourceBase: string,
  userAgent: string,
  limit: number,
  startPage = 1,
  endPage = 3,
): Promise<string[]> {
  const pageNumbers: number[] = [];
  for (let n = startPage; n <= endPage; n++) pageNumbers.push(n);

  const results = await Promise.allSettled(
    pageNumbers.map((n) => {
      const url =
        n === 1 ? `${sourceBase}/archives` : `${sourceBase}/archives?page=${n}`;
      return fetchText(url, userAgent);
    }),
  );

  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === "rejected") continue;
    if (seen.size >= limit) break;
    const { document } = parseHTML(r.value);
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (a as Element).getAttribute("href");
      if (!href) continue;
      if (!isArticleUrl(href)) continue;
      const normalized = normalizeUrl(href);
      seen.add(normalized);
      if (seen.size >= limit) break;
    }
  }
  return [...seen];
}

export interface ProbeResult {
  page: number;
  fetched_url: string;
  status: "ok" | "error";
  error?: string;
  article_urls: string[];
  all_host_links: string[];
}

export async function probeArchivePage(
  sourceBase: string,
  userAgent: string,
  page: number,
): Promise<ProbeResult> {
  const url =
    page <= 1
      ? `${sourceBase}/archives`
      : `${sourceBase}/archives?page=${page}`;
  try {
    const html = await fetchText(url, userAgent);
    const { document } = parseHTML(html);
    const host = new URL(sourceBase).hostname.replace(/^www\./, "");
    const articleUrls = new Set<string>();
    const hostLinks = new Set<string>();
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (a as Element).getAttribute("href");
      if (!href) continue;
      const abs = absolutize(href, sourceBase);
      if (!abs) continue;
      let parsed: URL;
      try {
        parsed = new URL(abs);
      } catch {
        continue;
      }
      if (parsed.hostname.replace(/^www\./, "") !== host) continue;
      hostLinks.add(normalizeUrl(abs));
      if (isArticleUrl(abs)) articleUrls.add(normalizeUrl(abs));
    }
    return {
      page,
      fetched_url: url,
      status: "ok",
      article_urls: [...articleUrls],
      all_host_links: [...hostLinks],
    };
  } catch (err) {
    return {
      page,
      fetched_url: url,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      article_urls: [],
      all_host_links: [],
    };
  }
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export interface SitemapDiscoveryResult {
  source: string;
  urls: string[];
}

export async function discoverFromSitemap(
  sourceBase: string,
  userAgent: string,
): Promise<SitemapDiscoveryResult | null> {
  const candidates = [
    `${sourceBase}/sitemap.xml`,
    `${sourceBase}/sitemap_index.xml`,
  ];
  // Also try robots.txt -> Sitemap: directives.
  try {
    const robots = await fetchText(`${sourceBase}/robots.txt`, userAgent);
    for (const line of robots.split(/\r?\n/)) {
      const m = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
      if (m?.[1] && !candidates.includes(m[1])) candidates.push(m[1]);
    }
  } catch {
    // robots.txt absent or blocked — fall through to default candidates
  }

  for (const candidate of candidates) {
    const urls = await collectSitemapUrls(
      candidate,
      userAgent,
      new Set<string>(),
    );
    if (urls.length > 0) {
      const articles = urls.filter(isArticleUrl).map(normalizeUrl);
      const unique = Array.from(new Set(articles));
      if (unique.length > 0) return { source: candidate, urls: unique };
    }
  }
  return null;
}

async function collectSitemapUrls(
  url: string,
  userAgent: string,
  visited: Set<string>,
): Promise<string[]> {
  if (visited.has(url) || visited.size > 50) return [];
  visited.add(url);
  let xml: string;
  try {
    xml = await fetchText(url, userAgent);
  } catch {
    return [];
  }
  const locs = Array.from(xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi))
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  if (locs.length === 0) return [];
  // Sitemap index: each <loc> is another sitemap to fetch.
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const out: string[] = [];
    for (const sub of locs) {
      const more = await collectSitemapUrls(sub, userAgent, visited);
      out.push(...more);
    }
    return out;
  }
  return locs;
}

export async function fetchAndParse(
  url: string,
  userAgent: string,
): Promise<ScrapedArticle | null> {
  const html = await fetchText(url, userAgent);
  return parseArticleHtml(url, html);
}

export function parseArticleHtml(
  url: string,
  html: string,
): ScrapedArticle | null {
  const { document } = parseHTML(html);

  const titleEl = document.querySelector("h1.entry-title");
  const dateEl = document.querySelector("span.entry-author");
  if (!titleEl || !dateEl) return null;

  const title = collapse(titleEl.textContent ?? "");
  const published_at = parseFrenchDate(dateEl.textContent ?? "");
  if (!published_at) return null;

  const priceContainers = document.querySelectorAll(
    "div.col-md-6.col-sm-12.col-xs-12",
  );
  let unit_price_chf: number | null = null;
  if (priceContainers.length > 1) {
    unit_price_chf = parsePriceText(priceContainers[1]?.textContent ?? "");
  }

  const is_paywalled = unit_price_chf !== null && unit_price_chf > 0;

  const contentEl =
    document.querySelector("div.entry-content") ??
    document.querySelector("article") ??
    document.body;

  const preview_text = is_paywalled
    ? extractPreview(contentEl, 1200)
    : extractText(contentEl, 8000);
  const full_text = is_paywalled ? null : extractText(contentEl, 50000);

  const hero_image_url = findHeroImage(document, contentEl);

  return {
    url: normalizeUrl(url),
    title,
    published_at,
    is_paywalled,
    unit_price_chf,
    preview_text,
    full_text,
    hero_image_url,
  };
}

export function parseFrenchDate(raw: string): string | null {
  // Format: "Le DD/MM/YYYY HH:MM" (sometimes "Le DD / MM / YYYY HH:MM")
  const cleaned = raw
    .replace(/ /g, " ")
    .replace(/Le\s+/i, "")
    .replace(/\s*\/\s*/g, "/")
    .trim();
  const match = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  if (!d || !m || !y) return null;
  const dd = d.padStart(2, "0");
  const mm = m.padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

export function parsePriceText(raw: string): number | null {
  const text = raw
    .replace(/Acheter cet article pour/i, " ")
    .replace(/seulement/i, " ")
    .replace(/CHF/gi, " ")
    .replace(/[^0-9.,]/g, " ")
    .replace(/,/g, ".")
    .trim();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function extractText(el: Element | null, max: number): string | null {
  if (!el) return null;
  const text = collapse(el.textContent ?? "");
  if (!text) return null;
  return text.slice(0, max);
}

function extractPreview(el: Element | null, max: number): string | null {
  if (!el) return null;
  const paragraphs = Array.from(el.querySelectorAll("p"))
    .map((p) => collapse(p.textContent ?? ""))
    .filter((t) => t.length > 0);
  const joined = paragraphs.join("\n\n");
  const trimmed = joined.length > 0 ? joined : collapse(el.textContent ?? "");
  return trimmed.slice(0, max) || null;
}

function findHeroImage(doc: Document, content: Element | null): string | null {
  const og = doc
    .querySelector('meta[property="og:image"]')
    ?.getAttribute("content");
  if (og) return og;
  const twitter = doc
    .querySelector('meta[name="twitter:image"]')
    ?.getAttribute("content");
  if (twitter) return twitter;
  // Try the content area first, then fall back to any storage-hosted image in the document.
  const contentImg = content?.querySelector("img[src]")?.getAttribute("src");
  if (contentImg) return contentImg;
  const storageImg = doc
    .querySelector('img[src*="/storage/app/uploads/public/"]')
    ?.getAttribute("src");
  return storageImg ?? null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "fr,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}
