import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverArticleUrls,
  parseArticleHtml,
  parseFrenchDate,
  parsePriceText,
} from '../src/scrape.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');

describe('parseFrenchDate', () => {
  it('parses canonical "Le DD/MM/YYYY HH:MM" form', () => {
    expect(parseFrenchDate('Le 12/04/2026 09:30')).toBe('2026-04-12');
  });
  it('tolerates spaced slashes', () => {
    expect(parseFrenchDate('Le 03 / 02 / 2026 14:05')).toBe('2026-02-03');
  });
  it('returns null on garbage', () => {
    expect(parseFrenchDate('whenever')).toBeNull();
  });
});

describe('parsePriceText', () => {
  it('extracts the CHF amount from the canonical phrasing', () => {
    expect(parsePriceText('Acheter cet article pour 2.50 seulement CHF')).toBe(2.5);
  });
  it('handles French comma decimals', () => {
    expect(parsePriceText('Acheter cet article pour 1,80 seulement CHF')).toBe(1.8);
  });
  it('returns null when no number is present', () => {
    expect(parsePriceText('Article gratuit')).toBeNull();
  });
});

describe('parseArticleHtml', () => {
  it('extracts a paid article', () => {
    const html = fixture('paid-article.html');
    const a = parseArticleHtml('https://www.businessmontres.com/article/rolex-ceo', html);
    expect(a).not.toBeNull();
    expect(a!.title).toBe('Rolex change de patron');
    expect(a!.published_at).toBe('2026-04-12');
    expect(a!.is_paywalled).toBe(true);
    expect(a!.unit_price_chf).toBe(2.5);
    expect(a!.preview_text).toContain('couronne');
    expect(a!.full_text).toBeNull();
    expect(a!.hero_image_url).toBe(
      'https://businessmontres.com/wp-content/uploads/rolex-tintin.jpg',
    );
    expect(a!.url).toBe('https://businessmontres.com/article/rolex-ceo');
  });

  it('extracts a free article and keeps full text', () => {
    const html = fixture('free-article.html');
    const a = parseArticleHtml('https://businessmontres.com/article/salon-2026', html);
    expect(a).not.toBeNull();
    expect(a!.is_paywalled).toBe(false);
    expect(a!.unit_price_chf).toBeNull();
    expect(a!.full_text).toContain('salon ouvre');
    expect(a!.full_text).toContain('marques indépendantes');
  });
});

describe('discoverArticleUrls', () => {
  afterEach(() => vi.unstubAllGlobals());

  function pageHtml(slugs: string[]): string {
    const links = slugs
      .map((s) => `<a href="https://www.businessmontres.com/article/${s}">x</a>`)
      .join('');
    return `<html><body>${links}</body></html>`;
  }

  it('stops early when a page yields no new URLs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/page/2')) return new Response(pageHtml(['a', 'b']));
      if (url.endsWith('/page/3')) return new Response(pageHtml(['a', 'b']));
      return new Response(pageHtml(['a', 'b']));
    });
    vi.stubGlobal('fetch', fetchMock);

    const urls = await discoverArticleUrls(
      'https://www.businessmontres.com',
      'test',
      100,
      10,
    );
    expect(urls).toHaveLength(2);
    // page 1 + page 2 (zero new → stop). page 3 should never be requested.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on a 404 listing page', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/page/2')) return new Response('not found', { status: 404 });
      return new Response(pageHtml(['a', 'b']));
    });
    vi.stubGlobal('fetch', fetchMock);

    const urls = await discoverArticleUrls(
      'https://www.businessmontres.com',
      'test',
      100,
      10,
    );
    expect(urls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
