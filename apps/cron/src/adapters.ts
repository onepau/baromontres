import { parseHTML } from "linkedom";
import type { SourceRow } from "@baromontres/shared/schema";
import type { ScrapedArticle } from "@baromontres/shared/queries";
import { upsertArticle } from "@baromontres/shared/queries";

export type ParsedArticle = Omit<ScrapedArticle, "source_id">;

// ── Shared helpers ────────────────────────────────────────────────────────────

async function fetchText(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "accept-language": "fr,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function normalizeUrl(u: string): string {
  try {
    const p = new URL(u);
    p.hash = "";
    p.search = "";
    p.hostname = p.hostname.replace(/^www\./, "");
    return p.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractText(el: Element | null, max: number): string | null {
  if (!el) return null;
  const text = collapse(el.textContent ?? "");
  return text ? text.slice(0, max) : null;
}

function findHeroImage(
  doc: Document,
  content: Element | null,
  pageUrl: string,
): string | null {
  const og = doc
    .querySelector('meta[property="og:image"]')
    ?.getAttribute("content");
  if (og) return og;
  const tw = doc
    .querySelector('meta[name="twitter:image"]')
    ?.getAttribute("content");
  if (tw) return tw;
  const img = content?.querySelector("img[src]")?.getAttribute("src");
  return img ? (absolutize(img, pageUrl) ?? img) : null;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoToDate(s: string): string | null {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? null;
}

function rfcToDate(s: string): string | null {
  try {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// ── Generic article HTML parser ───────────────────────────────────────────────

export function parseGenericArticleHtml(
  url: string,
  html: string,
  source: SourceRow,
): ParsedArticle | null {
  const { document } = parseHTML(html);

  const h1 = document.querySelector("h1");
  const ogTitle = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content");
  const title = collapse(h1?.textContent ?? ogTitle ?? "");
  if (!title) return null;

  // Date: time[datetime] → article:published_time meta → JSON-LD datePublished
  const timeEl = document.querySelector("time[datetime]");
  const pubMeta =
    document
      .querySelector('meta[property="article:published_time"]')
      ?.getAttribute("content") ??
    document
      .querySelector('meta[name="article:published_time"]')
      ?.getAttribute("content") ??
    document
      .querySelector('meta[property="og:article:published_time"]')
      ?.getAttribute("content");

  let published_at: string | null = null;
  if (timeEl) {
    published_at = isoToDate(timeEl.getAttribute("datetime") ?? "");
  }
  if (!published_at && pubMeta) {
    published_at = isoToDate(pubMeta);
  }
  if (!published_at) {
    for (const el of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    )) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = JSON.parse(el.textContent ?? "");
        const dp: string | undefined =
          d?.datePublished ?? d?.["@graph"]?.[0]?.datePublished;
        if (dp) {
          published_at = isoToDate(dp);
          if (published_at) break;
        }
      } catch {
        // malformed JSON-LD — skip
      }
    }
  }
  if (!published_at) return null;

  const contentEl =
    document.querySelector("article") ??
    document.querySelector('[role="main"]') ??
    document.querySelector("main") ??
    document.body;

  return {
    url: normalizeUrl(url),
    title,
    published_at,
    is_paywalled: source.is_paywalled_default === 1,
    unit_price_chf: null,
    preview_text: null,
    full_text: extractText(contentEl, 50000),
    hero_image_url: findHeroImage(document, contentEl, url),
  };
}

// ── RSS / Atom feed parser ────────────────────────────────────────────────────

interface FeedEntry {
  url: string;
  title: string;
  published_at: string;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function parseRssFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const isAtom = /<feed[\s>]/i.test(xml);

  if (isAtom) {
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1] ?? "";
      const linkM =
        block.match(
          /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i,
        ) ?? block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
      const url = linkM?.[1]?.trim() ?? "";
      if (!url.startsWith("http")) continue;

      const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = collapse(unescapeXml(stripCdata(titleM?.[1] ?? "")));

      const pubM =
        block.match(/<published>([\s\S]*?)<\/published>/i) ??
        block.match(/<updated>([\s\S]*?)<\/updated>/i);
      const published_at = pubM ? isoToDate(pubM[1]?.trim() ?? "") : null;
      if (!published_at) continue;

      entries.push({ url: normalizeUrl(url), title, published_at });
    }
  } else {
    const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[1] ?? "";
      const linkM =
        block.match(/<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i) ??
        block.match(/<link><!\[CDATA\[(https?:\/\/[^\]]+)\]\]><\/link>/i) ??
        block.match(/<guid[^>]*>(https?:\/\/[^<\s]+)<\/guid>/i);
      const url = linkM?.[1]?.trim() ?? "";
      if (!url.startsWith("http")) continue;

      const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = collapse(unescapeXml(stripCdata(titleM?.[1] ?? "")));

      const pubM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const published_at = pubM ? rfcToDate(pubM[1]?.trim() ?? "") : null;
      if (!published_at) continue;

      entries.push({ url: normalizeUrl(url), title, published_at });
    }
  }

  return entries;
}

// ── HTML listing configs for feed-less sources ────────────────────────────────

interface HtmlListingConfig {
  listingUrls: string[];
  articlePattern: RegExp;
}

const HTML_LISTING_CONFIGS: Record<string, HtmlListingConfig> = {
  europastar: {
    listingUrls: [
      "https://www.europastar.ch/news",
      "https://www.europastar.ch/watches",
    ],
    articlePattern: /europastar\.ch\/(news|watches|en|fr)\//i,
  },
  worldtempus: {
    listingUrls: ["https://fr.worldtempus.com"],
    articlePattern: /worldtempus\.com\/(fr|en)\/[a-z0-9-]+-\d+/i,
  },
  montresdeluxe: {
    listingUrls: ["https://www.montres-de-luxe.com"],
    articlePattern: /montres-de-luxe\.com\/\d{4}\/\d{2}\//i,
  },
  hhjournal: {
    listingUrls: [
      "https://www.hautehorlogerie.org/fr/actualites/",
      "https://www.hautehorlogerie.org/en/news/",
    ],
    articlePattern: /hautehorlogerie\.org\/(fr|en)\/(actualites|news)\//i,
  },
};

// ── Main: discover and upsert new articles for one source ─────────────────────

export async function runSourceDiscovery(
  source: SourceRow,
  seen: Set<string>,
  db: D1Database,
  userAgent: string,
  maxArticles = 5,
): Promise<{ upserted: number; errors: string[] }> {
  let upserted = 0;
  const errors: string[] = [];

  if (source.feed_url) {
    // ── RSS / Atom path ────────────────────────────────────────────────────
    let xml: string;
    try {
      xml = await fetchText(source.feed_url, userAgent);
    } catch (err) {
      errors.push(
        `feed ${source.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { upserted, errors };
    }

    const fresh = parseRssFeed(xml).filter((e) => !seen.has(e.url));
    for (const entry of fresh.slice(0, maxArticles)) {
      try {
        // Best-effort: fetch article HTML for full_text + hero_image_url.
        // If the fetch fails we still upsert with title+date from feed.
        let full_text: string | null = null;
        let hero_image_url: string | null = null;
        try {
          const html = await fetchText(entry.url, userAgent);
          const parsed = parseGenericArticleHtml(entry.url, html, source);
          if (parsed) {
            full_text = parsed.full_text;
            hero_image_url = parsed.hero_image_url;
          }
        } catch {
          // non-fatal
        }
        await upsertArticle(db, {
          url: entry.url,
          title: entry.title,
          published_at: entry.published_at,
          source_id: source.id,
          is_paywalled: source.is_paywalled_default === 1,
          unit_price_chf: null,
          preview_text: null,
          full_text,
          hero_image_url,
        });
        seen.add(entry.url);
        upserted++;
      } catch (err) {
        errors.push(
          `upsert ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    // ── HTML listing path ──────────────────────────────────────────────────
    const config = HTML_LISTING_CONFIGS[source.slug];
    if (!config) {
      console.warn(
        `adapters: no HTML config for source "${source.slug}" (no feed_url)`,
      );
      return { upserted, errors };
    }

    const candidates: string[] = [];
    for (const listingUrl of config.listingUrls) {
      try {
        const html = await fetchText(listingUrl, userAgent);
        const { document } = parseHTML(html);
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const href = (a as Element).getAttribute("href");
          if (!href) continue;
          const abs = absolutize(href, listingUrl);
          if (!abs || !config.articlePattern.test(abs)) continue;
          const normalized = normalizeUrl(abs);
          if (!seen.has(normalized)) candidates.push(normalized);
        }
      } catch (err) {
        errors.push(
          `listing ${listingUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const fresh = [...new Set(candidates)].slice(0, maxArticles);
    for (const url of fresh) {
      try {
        const html = await fetchText(url, userAgent);
        const parsed = parseGenericArticleHtml(url, html, source);
        if (!parsed) {
          console.warn(`adapters: parse returned null for ${url}`);
          continue;
        }
        await upsertArticle(db, { ...parsed, source_id: source.id });
        seen.add(url);
        upserted++;
      } catch (err) {
        errors.push(
          `scrape ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(
    `adapters: ${source.slug} upserted=${upserted} errors=${errors.length}`,
  );
  return { upserted, errors };
}
