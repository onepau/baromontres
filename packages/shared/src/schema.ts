export type SentimentLabel = 'positive' | 'neutral' | 'negative';
export type KeywordKind = 'brand' | 'topic' | 'person' | 'model';
export type SubscriptionPeriod = 'monthly' | 'yearly';

export interface ArticleRow {
  id: number;
  url: string;
  title: string;
  published_at: string;
  is_paywalled: 0 | 1;
  unit_price_chf: number | null;
  preview_text: string | null;
  full_text: string | null;
  hero_image_url: string | null;
  scraped_at: string;
  enriched_at: string | null;
}

export interface KeywordRow {
  id: number;
  article_id: number;
  term: string;
  term_en: string | null;
  kind: KeywordKind;
}

export interface SentimentRow {
  article_id: number;
  label: SentimentLabel;
  score: number;
  rationale: string | null;
}

export interface ImageAnalysisRow {
  id: number;
  article_id: number;
  image_url: string;
  is_hero: 0 | 1;
  pop_culture_source: string | null;
  ai_generated_likelihood: number | null;
  notes: string | null;
}

export interface SubscriptionPriceRow {
  observed_at: string;
  price_chf: number;
  period: SubscriptionPeriod;
}

export interface BarometerPoint {
  article_id: number;
  url: string;
  title: string;
  published_at: string;
  unit_price_chf: number;
  is_paywalled: 0 | 1;
  sentiment_label: SentimentLabel | null;
  sentiment_score: number | null;
  hero_image_url: string | null;
}

export interface ArticleDetail extends ArticleRow {
  keywords: KeywordRow[];
  sentiment: SentimentRow | null;
  images: ImageAnalysisRow[];
}

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}
