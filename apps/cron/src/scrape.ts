import { parseHTML } from 'linkedom';
import type { ScrapedArticle } from '@baromontres/shared/queries';

const ARTICLE_HREF = /https?:\/\/(www\.)?businessmontres\.com\/article\//i;

export async function discoverArticleUrls(
  sourceBase: string,
  userAgent: string,
  limit: number,
): Promise<string[]> {
  const seen = new Set<string>();
  const pagesToTry = [sourceBase, `${sourceBase}/page/2`, `${sourceBase}/page/3`];
  for (const page of pagesToTry) {
    if (seen.size >= limit) break;
    try {
      const html = await fetchText(page, userAgent);
      const { document } = parseHTML(html);
      const anchors = document.querySelectorAll('a[href]');
      for (const a of Array.from(anchors)) {
        const href = (a as Element).getAttribute('href');
        if (!href) continue;
        if (!ARTICLE_HREF.test(href)) continue;
        const normalized = normalizeUrl(href);
        seen.add(normalized);
        if (seen.size >= limit) break;
      }
    } catch {
      // ignore listing fetch errors; partial discovery is fine
    }
  }
  return [...seen];
}

export async function fetchAndParse(
  url: string,
  userAgent: string,
): Promise<ScrapedArticle | null> {
  const html = await fetchText(url, userAgent);
  return parseArticleHtml(url, html);
}

export function parseArticleHtml(url: string, html: string): ScrapedArticle | null {
  const { document } = parseHTML(html);

  const titleEl = document.querySelector('h1.entry-title');
  const dateEl = document.querySelector('span.entry-author');
  if (!titleEl || !dateEl) return null;

  const title = collapse(titleEl.textContent ?? '');
  const published_at = parseFrenchDate(dateEl.textContent ?? '');
  if (!published_at) return null;

  const priceContainers = document.querySelectorAll('div.col-md-6.col-sm-12.col-xs-12');
  let unit_price_chf: number | null = null;
  if (priceContainers.length > 1) {
    unit_price_chf = parsePriceText(priceContainers[1]?.textContent ?? '');
  }

  const is_paywalled = unit_price_chf !== null && unit_price_chf > 0;

  const contentEl =
    document.querySelector('div.entry-content') ??
    document.querySelector('article') ??
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
    .replace(/ /g, ' ')
    .replace(/Le\s+/i, '')
    .replace(/\s*\/\s*/g, '/')
    .trim();
  const match = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  if (!d || !m || !y) return null;
  const dd = d.padStart(2, '0');
  const mm = m.padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function parsePriceText(raw: string): number | null {
  const text = raw
    .replace(/Acheter cet article pour/i, ' ')
    .replace(/seulement/i, ' ')
    .replace(/CHF/gi, ' ')
    .replace(/[^0-9.,]/g, ' ')
    .replace(/,/g, '.')
    .trim();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function extractText(el: Element | null, max: number): string | null {
  if (!el) return null;
  const text = collapse(el.textContent ?? '');
  if (!text) return null;
  return text.slice(0, max);
}

function extractPreview(el: Element | null, max: number): string | null {
  if (!el) return null;
  const paragraphs = Array.from(el.querySelectorAll('p'))
    .map((p) => collapse(p.textContent ?? ''))
    .filter((t) => t.length > 0);
  const joined = paragraphs.join('\n\n');
  const trimmed = joined.length > 0 ? joined : collapse(el.textContent ?? '');
  return trimmed.slice(0, max) || null;
}

function findHeroImage(doc: Document, content: Element | null): string | null {
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  if (og) return og;
  const twitter = doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
  if (twitter) return twitter;
  const firstImg = content?.querySelector('img');
  return firstImg?.getAttribute('src') ?? null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    parsed.search = '';
    parsed.hostname = parsed.hostname.replace(/^www\./, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'fr,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}
