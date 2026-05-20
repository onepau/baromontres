import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverArticleUrls,
  parseArticleHtml,
  parseFrenchDate,
  parsePriceText,
} from "../src/scrape.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf8");

describe("parseFrenchDate", () => {
  it('parses canonical "Le DD/MM/YYYY HH:MM" form', () => {
    expect(parseFrenchDate("Le 12/04/2026 09:30")).toBe("2026-04-12");
  });
  it("tolerates spaced slashes", () => {
    expect(parseFrenchDate("Le 03 / 02 / 2026 14:05")).toBe("2026-02-03");
  });
  it("returns null on garbage", () => {
    expect(parseFrenchDate("whenever")).toBeNull();
  });
});

describe("parsePriceText", () => {
  it("extracts the CHF amount from the canonical phrasing", () => {
    expect(parsePriceText("Acheter cet article pour 2.50 seulement CHF")).toBe(
      2.5,
    );
  });
  it("handles French comma decimals", () => {
    expect(parsePriceText("Acheter cet article pour 1,80 seulement CHF")).toBe(
      1.8,
    );
  });
  it("returns null when no number is present", () => {
    expect(parsePriceText("Article gratuit")).toBeNull();
  });
});

describe("parseArticleHtml", () => {
  it("extracts a paid article", () => {
    const html = fixture("paid-article.html");
    const a = parseArticleHtml(
      "https://www.businessmontres.com/article/rolex-ceo",
      html,
    );
    expect(a).not.toBeNull();
    expect(a!.title).toBe("Rolex change de patron");
    expect(a!.published_at).toBe("2026-04-12");
    expect(a!.is_paywalled).toBe(true);
    expect(a!.unit_price_chf).toBe(2.5);
    expect(a!.preview_text).toContain("couronne");
    expect(a!.full_text).toBeNull();
    expect(a!.hero_image_url).toBe(
      "https://businessmontres.com/wp-content/uploads/rolex-tintin.jpg",
    );
    expect(a!.url).toBe("https://businessmontres.com/article/rolex-ceo");
  });

  it("extracts a free article and keeps full text", () => {
    const html = fixture("free-article.html");
    const a = parseArticleHtml(
      "https://businessmontres.com/article/salon-2026",
      html,
    );
    expect(a).not.toBeNull();
    expect(a!.is_paywalled).toBe(false);
    expect(a!.unit_price_chf).toBeNull();
    expect(a!.full_text).toContain("salon ouvre");
    expect(a!.full_text).toContain("marques indépendantes");
  });
});

describe("findHeroImage URL absolutization", () => {
  function articleShell(head: string, body: string): string {
    return `<html><head>${head}</head><body>
      <h1 class="entry-title">Test</h1>
      <span class="entry-author">Le 01/01/2026 10:00</span>
      <div class="entry-content">${body}</div>
    </body></html>`;
  }

  it("resolves a relative storage path to an absolute URL", () => {
    const html = articleShell(
      "",
      '<img src="/storage/app/uploads/public/abc/thumb.jpg">',
    );
    const a = parseArticleHtml(
      "https://www.businessmontres.com/article/test",
      html,
    );
    expect(a!.hero_image_url).toBe(
      "https://www.businessmontres.com/storage/app/uploads/public/abc/thumb.jpg",
    );
  });

  it("prefers og:image over storage fallback", () => {
    const html = articleShell(
      '<meta property="og:image" content="https://cdn.example.com/image.jpg">',
      '<img src="/storage/app/uploads/public/abc/thumb.jpg">',
    );
    const a = parseArticleHtml(
      "https://www.businessmontres.com/article/test",
      html,
    );
    expect(a!.hero_image_url).toBe("https://cdn.example.com/image.jpg");
  });
});

describe("discoverArticleUrls", () => {
  afterEach(() => vi.unstubAllGlobals());

  function pageHtml(slugs: string[]): string {
    const links = slugs
      .map(
        (s) => `<a href="https://www.businessmontres.com/article/${s}">x</a>`,
      )
      .join("");
    return `<html><body>${links}</body></html>`;
  }

  it("deduplicates URLs across pages", async () => {
    const fetchMock = vi.fn(async () => new Response(pageHtml(["a", "b"])));
    vi.stubGlobal("fetch", fetchMock);

    const urls = await discoverArticleUrls(
      "https://www.businessmontres.com",
      "test",
      100,
      1,
      5,
    );
    expect(urls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("skips pages that return errors", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/archives?page=2"))
        return new Response("not found", { status: 404 });
      return new Response(pageHtml(["a", "b"]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const urls = await discoverArticleUrls(
      "https://www.businessmontres.com",
      "test",
      100,
      1,
      5,
    );
    expect(urls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("respects a startPage offset and skips earlier pages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/archives?page=11"))
        return new Response(pageHtml(["x", "y"]));
      if (url.endsWith("/archives?page=12"))
        return new Response(pageHtml(["z"]));
      return new Response("should not fetch", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const urls = await discoverArticleUrls(
      "https://www.businessmontres.com",
      "test",
      100,
      11,
      12,
    );
    expect(urls).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
