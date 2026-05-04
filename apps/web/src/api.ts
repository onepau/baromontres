import type { BarometerPoint, KeywordKind, SubscriptionPriceRow } from '@baromontres/shared/schema';

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
  notes: string | null;
}

export async function fetchBarometer(since?: string): Promise<BarometerResponse> {
  const url = since ? `/api/barometer?since=${encodeURIComponent(since)}` : '/api/barometer';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`barometer ${res.status}`);
  return res.json();
}

export async function fetchKeywords(
  kind?: KeywordKind,
  limit = 30,
  minCount?: number,
): Promise<KeywordFreq[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind) params.set('kind', kind);
  if (minCount && minCount > 1) params.set('min_count', String(minCount));
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
