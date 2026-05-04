import type { ArticleRow, Env } from '@baromontres/shared/schema';
import { persistEnrichment, type EnrichmentInput } from '@baromontres/shared/queries';
import {
  IMAGE_ENRICH_SYSTEM,
  TEXT_ENRICH_SYSTEM,
  type ImageEnrichmentResponse,
  type TextEnrichmentResponse,
} from './prompts.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

export async function enrichArticle(env: Env, row: ArticleRow): Promise<void> {
  const text = await callTextEnrichment(env.ANTHROPIC_API_KEY, row);
  const images = await callImageEnrichment(env.ANTHROPIC_API_KEY, row);
  const payload: EnrichmentInput = {
    article_id: row.id,
    sentiment: {
      label: text.sentiment.label,
      score: clamp(text.sentiment.score, -1, 1),
      rationale: text.sentiment.rationale ?? null,
    },
    keywords: dedupeKeywords(text.keywords).map((k) => ({
      term: k.term,
      term_en: k.term_en ?? null,
      kind: k.kind,
    })),
    images,
  };
  await persistEnrichment(env.DB, payload);
}

async function callTextEnrichment(
  apiKey: string,
  row: ArticleRow,
): Promise<TextEnrichmentResponse> {
  const userBlock = buildTextUserBlock(row);
  const json = await callClaudeJson(apiKey, {
    system: TEXT_ENRICH_SYSTEM,
    user: userBlock,
    max_tokens: 800,
  });
  return validateText(json);
}

async function callImageEnrichment(
  apiKey: string,
  row: ArticleRow,
): Promise<EnrichmentInput['images']> {
  if (!row.hero_image_url) return [];
  try {
    const json = await callClaudeJson(apiKey, {
      system: IMAGE_ENRICH_SYSTEM,
      max_tokens: 300,
      content: [
        {
          type: 'image',
          source: { type: 'url', url: row.hero_image_url },
        },
        {
          type: 'text',
          text: `Titre de l'article : ${row.title}`,
        },
      ],
    });
    const parsed = validateImage(json);
    return [
      {
        image_url: row.hero_image_url,
        is_hero: true,
        pop_culture_source: parsed.pop_culture_source,
        ai_generated_likelihood: clamp(parsed.ai_generated_likelihood, 0, 1),
        notes: parsed.notes ?? null,
      },
    ];
  } catch (err) {
    // image fetch can fail (CDN expired, hotlink protection); record nothing
    console.warn('image enrichment failed', row.url, stringifyError(err));
    return [];
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function buildTextUserBlock(row: ArticleRow): string {
  const lines = [
    `Titre : ${row.title}`,
    `Date : ${row.published_at}`,
    `Article payant : ${row.is_paywalled ? 'oui' : 'non'}`,
  ];
  const body = row.full_text ?? row.preview_text ?? '';
  lines.push('', body || '(aucun texte disponible — utilise uniquement le titre)');
  return lines.join('\n');
}

interface ClaudeCallArgs {
  system: string;
  max_tokens: number;
  user?: string;
  content?: Array<Record<string, unknown>>;
}

async function callClaudeJson(apiKey: string, args: ClaudeCallArgs): Promise<unknown> {
  const messages = [
    {
      role: 'user',
      content:
        args.content ??
        [{ type: 'text', text: args.user ?? '' }],
    },
  ];
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: args.max_tokens,
      system: [
        {
          type: 'text',
          text: args.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`anthropic ${res.status}: ${detail.slice(0, 400)}`);
  }
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = body.content?.find((b) => b.type === 'text');
  const text = textBlock?.text;
  if (!text) throw new Error('anthropic returned no text content');
  return extractJson(text);
}

function extractJson(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = fenceMatch?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateText(raw: unknown): TextEnrichmentResponse {
  if (!isObj(raw)) throw new Error('text enrichment: not an object');
  const sentiment = raw.sentiment;
  const keywords = raw.keywords;
  if (!isObj(sentiment)) throw new Error('text enrichment: missing sentiment');
  if (!Array.isArray(keywords)) throw new Error('text enrichment: keywords not array');
  const label = sentiment.label;
  if (label !== 'positive' && label !== 'neutral' && label !== 'negative') {
    throw new Error(`text enrichment: bad sentiment label ${String(label)}`);
  }
  const score = Number(sentiment.score);
  if (!Number.isFinite(score)) throw new Error('text enrichment: bad sentiment score');
  return {
    sentiment: {
      label,
      score,
      rationale: typeof sentiment.rationale === 'string' ? sentiment.rationale : '',
    },
    keywords: keywords
      .filter((k): k is Record<string, unknown> => isObj(k))
      .map((k) => ({
        term: String(k.term ?? '').trim(),
        term_en: typeof k.term_en === 'string' ? k.term_en : null,
        kind: validateKeywordKind(k.kind),
      }))
      .filter((k) => k.term.length > 0),
  };
}

function validateKeywordKind(v: unknown): 'brand' | 'topic' | 'person' | 'model' {
  if (v === 'brand' || v === 'topic' || v === 'person' || v === 'model') return v;
  return 'topic';
}

function validateImage(raw: unknown): ImageEnrichmentResponse {
  if (!isObj(raw)) throw new Error('image enrichment: not an object');
  const src = raw.pop_culture_source;
  const allowed = new Set(['peanuts', 'tintin', 'asterix', 'gaston', 'calvin_hobbes', 'other']);
  return {
    pop_culture_source:
      typeof src === 'string' && allowed.has(src)
        ? (src as ImageEnrichmentResponse['pop_culture_source'])
        : null,
    ai_generated_likelihood: Number(raw.ai_generated_likelihood ?? 0),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function dedupeKeywords<T extends { term: string; kind: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.term.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
