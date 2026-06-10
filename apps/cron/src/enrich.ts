import type { ArticleRow, Env } from "@baromontres/shared/schema";
import {
  persistEnrichment,
  type EnrichmentInput,
} from "@baromontres/shared/queries";
import {
  IMAGE_ENRICH_SYSTEM,
  TEXT_ENRICH_SYSTEM,
  type ImageEnrichmentResponse,
  type TextEnrichmentResponse,
} from "./prompts.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

export async function enrichArticle(env: Env, row: ArticleRow): Promise<void> {
  const text = await callTextEnrichment(env.ANTHROPIC_API_KEY, row);
  const images = await callImageEnrichment(
    env.ANTHROPIC_API_KEY,
    env.GOOGLE_VISION_API_KEY,
    row,
  );
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

// ── Vision types ──────────────────────────────────────────────────────────────

interface VisionResult {
  bestGuessLabel: string | null;
  webEntities: string[];
  fullMatchUrls: string[];
  partialMatchUrls: string[];
  sourcePageUrls: string[];
}

// ── Cartoon / watch detection ─────────────────────────────────────────────────

type PopCultureSource =
  | "peanuts"
  | "tintin"
  | "asterix"
  | "gaston"
  | "calvin_hobbes"
  | "other";

const CARTOON_ENTITY_MAP: Record<string, PopCultureSource> = {
  tintin: "tintin",
  hergé: "tintin",
  herge: "tintin",
  milou: "tintin",
  peanuts: "peanuts",
  "charlie brown": "peanuts",
  snoopy: "peanuts",
  woodstock: "peanuts",
  astérix: "asterix",
  asterix: "asterix",
  obélix: "asterix",
  obelix: "asterix",
  uderzo: "asterix",
  "gaston lagaffe": "gaston",
  lagaffe: "gaston",
  franquin: "gaston",
  "calvin and hobbes": "calvin_hobbes",
  "calvin & hobbes": "calvin_hobbes",
  "bill watterson": "calvin_hobbes",
  watterson: "calvin_hobbes",
};

const WATCH_TERMS = new Set([
  "watch",
  "montre",
  "horloge",
  "horlogerie",
  "timepiece",
  "wristwatch",
  "chronograph",
  "tourbillon",
  "movement",
  "calibre",
  "caliber",
  "watchmaking",
  "haute horlogerie",
  "rolex",
  "omega",
  "patek",
  "audemars",
  "iwc",
  "breitling",
  "tag heuer",
  "cartier watch",
  "hublot",
  "zenith",
  "longines",
  "tissot",
  "jaeger",
  "vacheron",
  "blancpain",
  "glashütte",
  "a. lange",
]);

function detectCartoon(vision: VisionResult): PopCultureSource | null {
  const candidates = [
    ...vision.webEntities.map((e) => e.toLowerCase()),
    vision.bestGuessLabel?.toLowerCase() ?? "",
  ];
  for (const text of candidates) {
    for (const [key, source] of Object.entries(CARTOON_ENTITY_MAP)) {
      if (text.includes(key)) return source;
    }
  }
  return null;
}

function detectWatchContent(vision: VisionResult): boolean {
  const candidates = [
    ...vision.webEntities.map((e) => e.toLowerCase()),
    vision.bestGuessLabel?.toLowerCase() ?? "",
  ];
  for (const text of candidates) {
    for (const term of WATCH_TERMS) {
      if (text.includes(term)) return true;
    }
  }
  return false;
}

function buildVisionSourceClue(vision: VisionResult): string | null {
  const parts: string[] = [];
  if (vision.webEntities.length > 0) {
    parts.push(vision.webEntities.slice(0, 3).join(", "));
  }
  if (vision.sourcePageUrls.length > 0) {
    parts.push(vision.sourcePageUrls[0]!);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

// ── Image enrichment pipeline ─────────────────────────────────────────────────

async function callImageEnrichment(
  anthropicKey: string,
  visionKey: string,
  row: ArticleRow,
): Promise<EnrichmentInput["images"]> {
  if (!row.hero_image_url) return [];
  const imageUrl = row.hero_image_url;

  try {
    const [vision, exifMeta] = await Promise.all([
      callVisionWebDetection(visionKey, imageUrl),
      extractImageMeta(imageUrl),
    ]);

    const cartoonSource = detectCartoon(vision);
    const hasWatchContent = detectWatchContent(vision);
    const visionClue = buildVisionSourceClue(vision);
    const sourceClue =
      [visionClue, exifMeta].filter(Boolean).join("; ") || null;

    if (cartoonSource) {
      // Vision identified the cartoon source — no Claude call needed
      const hasTextOverlay =
        vision.partialMatchUrls.length > 0 && vision.fullMatchUrls.length === 0;
      return [
        {
          image_url: imageUrl,
          is_hero: true,
          pop_culture_source: cartoonSource,
          ai_generated_likelihood: null,
          not_watch_image: true,
          has_text_overlay: hasTextOverlay,
          source_clue: sourceClue,
          notes: vision.bestGuessLabel ?? null,
        },
      ];
    }

    if (hasWatchContent) {
      // Vision confirmed watch content — no Claude call needed
      return [
        {
          image_url: imageUrl,
          is_hero: true,
          pop_culture_source: null,
          ai_generated_likelihood: null,
          not_watch_image: false,
          has_text_overlay: null,
          source_clue: sourceClue,
          notes: vision.bestGuessLabel ?? null,
        },
      ];
    }

    // Vision inconclusive — fall back to Claude for classification
    const json = await callClaudeJson(anthropicKey, {
      system: IMAGE_ENRICH_SYSTEM,
      max_tokens: 300,
      content: [
        {
          type: "image",
          source: { type: "url", url: imageUrl },
        },
        {
          type: "text",
          text: `Article title: ${row.title}`,
        },
      ],
    });
    const parsed = validateImage(json);
    return [
      {
        image_url: imageUrl,
        is_hero: true,
        pop_culture_source: null,
        ai_generated_likelihood: clamp(parsed.ai_generated_likelihood, 0, 1),
        not_watch_image: parsed.not_watch_image,
        has_text_overlay: parsed.has_text_overlay,
        source_clue: sourceClue,
        notes: parsed.notes ?? null,
      },
    ];
  } catch (err) {
    const msg = stringifyError(err);
    console.warn("image enrichment failed", row.url, msg);
    return [
      {
        image_url: imageUrl,
        is_hero: true,
        pop_culture_source: null,
        ai_generated_likelihood: null,
        not_watch_image: null,
        has_text_overlay: null,
        source_clue: null,
        notes: `fetch_failed: ${msg.slice(0, 200)}`,
      },
    ];
  }
}

async function callVisionWebDetection(
  apiKey: string,
  imageUrl: string,
): Promise<VisionResult> {
  const empty: VisionResult = {
    bestGuessLabel: null,
    webEntities: [],
    fullMatchUrls: [],
    partialMatchUrls: [],
    sourcePageUrls: [],
  };

  const res = await fetch(`${VISION_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { source: { imageUri: imageUrl } },
          features: [{ type: "WEB_DETECTION", maxResults: 10 }],
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(`vision ${res.status}: ${detail.slice(0, 400)}`);
    throw new Error(`vision request failed (${res.status})`);
  }

  const body = (await res.json()) as {
    responses?: Array<{
      webDetection?: {
        bestGuessLabels?: Array<{ label: string }>;
        webEntities?: Array<{ description?: string; score?: number }>;
        fullMatchingImages?: Array<{ url: string }>;
        partialMatchingImages?: Array<{ url: string }>;
        pagesWithMatchingImages?: Array<{ url: string }>;
      };
      error?: { message: string };
    }>;
  };

  const response = body.responses?.[0];
  if (!response) return empty;
  if (response.error) {
    console.error(`vision error: ${response.error.message}`);
    throw new Error("vision request failed (api error)");
  }

  const wd = response.webDetection;
  if (!wd) return empty;

  return {
    bestGuessLabel: wd.bestGuessLabels?.[0]?.label ?? null,
    webEntities: (wd.webEntities ?? [])
      .filter((e) => e.description && (e.score ?? 0) >= 0.5)
      .map((e) => e.description!)
      .slice(0, 10),
    fullMatchUrls: (wd.fullMatchingImages ?? []).map((i) => i.url).slice(0, 5),
    partialMatchUrls: (wd.partialMatchingImages ?? [])
      .map((i) => i.url)
      .slice(0, 5),
    sourcePageUrls: (wd.pagesWithMatchingImages ?? [])
      .map((p) => p.url)
      .slice(0, 3),
  };
}

// ── Text enrichment ───────────────────────────────────────────────────────────

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function buildTextUserBlock(row: ArticleRow): string {
  const body = row.full_text ?? row.preview_text ?? "";
  return [
    "<article>",
    `<titre>${row.title}</titre>`,
    `<date>${row.published_at}</date>`,
    `<payant>${row.is_paywalled ? "oui" : "non"}</payant>`,
    "<texte>",
    body || "(aucun texte disponible — utilise uniquement le titre)",
    "</texte>",
    "</article>",
  ].join("\n");
}

interface ClaudeCallArgs {
  system: string;
  max_tokens: number;
  user?: string;
  content?: Array<Record<string, unknown>>;
}

async function callClaudeJson(
  apiKey: string,
  args: ClaudeCallArgs,
): Promise<unknown> {
  const messages = [
    {
      role: "user",
      content: args.content ?? [{ type: "text", text: args.user ?? "" }],
    },
  ];
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: args.max_tokens,
      system: [
        {
          type: "text",
          text: args.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error(`anthropic ${res.status}: ${detail.slice(0, 400)}`);
    throw new Error(`anthropic request failed (${res.status})`);
  }
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = body.content?.find((b) => b.type === "text");
  const text = textBlock?.text;
  if (!text) throw new Error("anthropic returned no text content");
  return extractJson(text);
}

function extractJson(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = fenceMatch?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateText(raw: unknown): TextEnrichmentResponse {
  if (!isObj(raw)) throw new Error("text enrichment: not an object");
  const sentiment = raw.sentiment;
  const keywords = raw.keywords;
  if (!isObj(sentiment)) throw new Error("text enrichment: missing sentiment");
  if (!Array.isArray(keywords))
    throw new Error("text enrichment: keywords not array");
  const label = sentiment.label;
  if (label !== "positive" && label !== "neutral" && label !== "negative") {
    throw new Error(`text enrichment: bad sentiment label ${String(label)}`);
  }
  const score = Number(sentiment.score);
  if (!Number.isFinite(score))
    throw new Error("text enrichment: bad sentiment score");
  return {
    sentiment: {
      label,
      score,
      rationale:
        typeof sentiment.rationale === "string" ? sentiment.rationale : "",
    },
    keywords: keywords
      .filter((k): k is Record<string, unknown> => isObj(k))
      .map((k) => ({
        term: String(k.term ?? "").trim(),
        term_en: typeof k.term_en === "string" ? k.term_en : null,
        kind: validateKeywordKind(k.kind),
      }))
      .filter((k) => k.term.length > 0),
  };
}

function validateKeywordKind(
  v: unknown,
): "brand" | "topic" | "person" | "model" {
  if (v === "brand" || v === "topic" || v === "person" || v === "model")
    return v;
  return "topic";
}

// Claude fallback: only parses the three fields Vision cannot determine
function validateImage(raw: unknown): ImageEnrichmentResponse {
  if (!isObj(raw)) throw new Error("image enrichment: not an object");
  return {
    not_watch_image: raw.not_watch_image === true,
    has_text_overlay: raw.has_text_overlay === true,
    ai_generated_likelihood: Number(raw.ai_generated_likelihood ?? 0),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

// ── EXIF / URL metadata ───────────────────────────────────────────────────────

const STOCK_HOSTS = new Set([
  "shutterstock.com",
  "gettyimages.com",
  "istockphoto.com",
  "adobestock.com",
  "dreamstime.com",
  "depositphotos.com",
  "alamy.com",
  "fotolia.com",
  "pond5.com",
  "123rf.com",
  "bigstockphoto.com",
]);

async function extractImageMeta(imageUrl: string): Promise<string | null> {
  const clues: string[] = [];
  try {
    const host = new URL(imageUrl).hostname.replace(/^www\./, "");
    if (STOCK_HOSTS.has(host)) clues.push(`stock:${host}`);
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(imageUrl, {
      headers: { Range: "bytes=0-65535" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok || res.status === 206) {
      const buf = await res.arrayBuffer();
      const exif = parseJpegExif(new DataView(buf));
      if (exif.software) clues.push(`software:${exif.software}`);
      if (exif.copyright) clues.push(`copyright:${exif.copyright}`);
      if (exif.artist) clues.push(`artist:${exif.artist}`);
    }
  } catch {
    /* ignore — EXIF is best-effort */
  }
  return clues.length > 0 ? clues.join("; ") : null;
}

interface ExifFields {
  software: string | null;
  copyright: string | null;
  artist: string | null;
}

function parseJpegExif(view: DataView): ExifFields {
  const empty: ExifFields = { software: null, copyright: null, artist: null };
  if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8) return empty;
  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    const marker = view.getUint16(pos);
    if (marker === 0xffda) break; // SOS — no more metadata segments
    const segLen = view.getUint16(pos + 2);
    if (
      marker === 0xffe1 &&
      pos + 10 <= view.byteLength &&
      view.getUint32(pos + 4) === 0x45786966 && // "Exif"
      view.getUint16(pos + 8) === 0x0000
    ) {
      return parseTiffIfd(view, pos + 10);
    }
    pos += 2 + segLen;
  }
  return empty;
}

function parseTiffIfd(view: DataView, tiffStart: number): ExifFields {
  const empty: ExifFields = { software: null, copyright: null, artist: null };
  if (tiffStart + 8 > view.byteLength) return empty;
  const le = view.getUint16(tiffStart) === 0x4949;
  const g16 = (o: number) => view.getUint16(o, le);
  const g32 = (o: number) => view.getUint32(o, le);
  if (g16(tiffStart + 2) !== 42) return empty;
  const ifdStart = tiffStart + g32(tiffStart + 4);
  if (ifdStart + 2 > view.byteLength) return empty;
  const WANT: Record<number, keyof ExifFields> = {
    0x0131: "software",
    0x8298: "copyright",
    0x013b: "artist",
  };
  const out = { ...empty };
  const count = g16(ifdStart);
  for (let i = 0; i < count; i++) {
    const e = ifdStart + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    const field = WANT[g16(e)];
    if (!field || g16(e + 2) !== 2) continue; // ASCII strings only
    const cnt = g32(e + 4);
    const strStart = cnt <= 4 ? e + 8 : tiffStart + g32(e + 8);
    if (strStart + cnt > view.byteLength) continue;
    const chars: string[] = [];
    for (let j = 0; j < cnt - 1; j++) {
      const b = view.getUint8(strStart + j);
      if (b === 0) break;
      chars.push(String.fromCharCode(b));
    }
    const s = chars.join("").trim();
    if (s) out[field] = s;
  }
  return out;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function dedupeKeywords<T extends { term: string; kind: string }>(
  items: T[],
): T[] {
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
