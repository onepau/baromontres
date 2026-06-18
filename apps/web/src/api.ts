import type {
  BarometerPoint,
  KeywordKind,
  Lang,
  SourceRow,
  SubscriptionPriceRow,
} from "@baromontres/shared/schema";

export type { Lang, SourceRow };

export interface BarometerResponse {
  points: BarometerPoint[];
  subscription: SubscriptionPriceRow | null;
}

export interface KeywordFreq {
  term: string;
  term_en: string | null;
  kind: KeywordKind;
  article_count: number;
}

export interface FlaggedImage {
  article_id: number;
  url: string;
  title: string;
  published_at: string;
  image_url: string;
  pop_culture_source: string | null;
  ai_generated_likelihood: number | null;
  not_watch_image: 0 | 1 | null;
  has_text_overlay: 0 | 1 | null;
  source_clue: string | null;
  notes: string | null;
}

export async function fetchBarometer(
  since?: string,
): Promise<BarometerResponse> {
  const url = since
    ? `/api/barometer?since=${encodeURIComponent(since)}`
    : "/api/barometer";
  const res = await fetch(url, { priority: "high" } as RequestInit);
  if (!res.ok) throw new Error(`barometer ${res.status}`);
  return res.json();
}

export async function fetchKeywords(
  kind?: KeywordKind,
  limit = 30,
  minCount?: number,
): Promise<KeywordFreq[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind) params.set("kind", kind);
  if (minCount && minCount > 1) params.set("min_count", String(minCount));
  const res = await fetch(`/api/keywords?${params.toString()}`);
  if (!res.ok) throw new Error(`keywords ${res.status}`);
  const data = (await res.json()) as { frequencies: KeywordFreq[] };
  return data.frequencies;
}

export async function fetchFlaggedImages(limit = 12): Promise<FlaggedImage[]> {
  const res = await fetch(`/api/images/flagged?limit=${limit}`);
  if (!res.ok) throw new Error(`flagged ${res.status}`);
  const data = (await res.json()) as { flags: FlaggedImage[] };
  return data.flags;
}

export interface PaywallStats {
  since: string;
  paywalled_count: number;
  free_count: number;
  priced_paywalled_count: number;
  total_unit_price_chf: number;
  avg_unit_price_chf: number | null;
  subscription_tiers: Record<string, number>;
}

export async function fetchPaywall(since?: string): Promise<PaywallStats> {
  const url = since
    ? `/api/paywall?since=${encodeURIComponent(since)}`
    : "/api/paywall";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`paywall ${res.status}`);
  return res.json();
}

export interface BrandLeaderboardRow {
  term: string;
  term_en: string | null;
  article_count: number;
  positive: number;
  neutral: number;
  negative: number;
  avg_score: number | null;
  net_sentiment: number;
}

export async function fetchBrands(
  limit = 20,
  minCount = 3,
): Promise<BrandLeaderboardRow[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    min_count: String(minCount),
  });
  const res = await fetch(`/api/brands?${params.toString()}`);
  if (!res.ok) throw new Error(`brands ${res.status}`);
  const data = (await res.json()) as { brands: BrandLeaderboardRow[] };
  return data.brands;
}

export async function fetchSources(): Promise<SourceRow[]> {
  const res = await fetch("/api/sources");
  if (!res.ok) throw new Error(`sources ${res.status}`);
  const data = (await res.json()) as { sources: SourceRow[] };
  return data.sources;
}

export interface SourceSentiment {
  source_id: number;
  slug: string;
  name: string;
  lang: Lang;
  weight: number;
  article_count: number;
  positive: number;
  neutral: number;
  negative: number;
  net_sentiment: number;
}

export interface SentimentPanel {
  since: string;
  sources: SourceSentiment[];
  by_language: Array<{
    lang: Lang;
    net_sentiment: number;
    source_count: number;
  }>;
  combined: number;
}

export async function fetchSentimentPanel(
  since?: string,
): Promise<SentimentPanel> {
  const url = since
    ? `/api/sentiment/panel?since=${encodeURIComponent(since)}`
    : "/api/sentiment/panel";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sentiment panel ${res.status}`);
  return res.json();
}
