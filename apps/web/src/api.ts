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

export async function fetchBarometer(since?: string): Promise<BarometerResponse> {
  const url = since ? `/api/barometer?since=${encodeURIComponent(since)}` : '/api/barometer';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`barometer ${res.status}`);
  return res.json();
}

export async function fetchKeywords(kind?: KeywordKind, limit = 30): Promise<KeywordFreq[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind) params.set('kind', kind);
  const res = await fetch(`/api/keywords?${params.toString()}`);
  if (!res.ok) throw new Error(`keywords ${res.status}`);
  const data = (await res.json()) as { frequencies: KeywordFreq[] };
  return data.frequencies;
}
