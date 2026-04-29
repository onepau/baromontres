import 'chartjs-adapter-date-fns';
import { applyDom, bindLangSwitch, getLang, setLang, t } from './i18n.ts';
import { fetchBarometer, fetchKeywords } from './api.ts';
import { renderBarometer } from './chart.ts';
import type { BarometerPoint } from '@baromontres/shared/schema';
import type { Chart } from 'chart.js';

let chart: Chart | null = null;
let lastPoints: BarometerPoint[] = [];

async function boot(): Promise<void> {
  setLang(getLang());
  bindLangSwitch(() => {
    applyDom();
    renderTopics();
    renderImageFlags();
  });
  await Promise.all([renderChart(), renderTopics(), renderImageFlags()]);
}

async function renderChart(): Promise<void> {
  const canvas = document.getElementById('barometer') as HTMLCanvasElement | null;
  const tooltipEl = document.getElementById('tooltip');
  if (!canvas || !tooltipEl) return;
  try {
    const { points, subscription } = await fetchBarometer();
    lastPoints = points;
    chart?.destroy();
    chart = renderBarometer(canvas, tooltipEl, points, subscription);
    updateMeta(points, subscription?.price_chf ?? null);
  } catch (err) {
    console.error(err);
    document.getElementById('meta-period')!.textContent = '—';
  }
}

function updateMeta(points: BarometerPoint[], subscription: number | null): void {
  const period = document.getElementById('meta-period')!;
  const avg = document.getElementById('meta-average')!;
  const count = document.getElementById('meta-count')!;
  const sub = document.getElementById('meta-subscription')!;
  if (points.length === 0) {
    period.textContent = '—';
    avg.textContent = '—';
    count.textContent = '0';
    sub.textContent = subscription !== null ? `${subscription.toFixed(2)} CHF` : '—';
    return;
  }
  const sorted = [...points].sort((a, b) => a.published_at.localeCompare(b.published_at));
  const start = sorted[0]!.published_at;
  const end = sorted[sorted.length - 1]!.published_at;
  const lang = getLang();
  period.textContent = `${formatShortDate(start, lang)} — ${formatShortDate(end, lang)}`;
  const mean =
    points.reduce((acc, p) => acc + p.unit_price_chf, 0) / points.length;
  avg.textContent = `${mean.toFixed(2)} CHF`;
  count.textContent = String(points.length);
  sub.textContent = subscription !== null ? `${subscription.toFixed(2)} CHF` : '—';
}

async function renderTopics(): Promise<void> {
  const brandsEl = document.getElementById('brands');
  const topicsEl = document.getElementById('topics');
  if (!brandsEl || !topicsEl) return;
  try {
    const [brands, topics] = await Promise.all([
      fetchKeywords('brand', 30),
      fetchKeywords('topic', 30),
    ]);
    brandsEl.replaceChildren(...brands.map(chipNode));
    topicsEl.replaceChildren(...topics.map(chipNode));
  } catch (err) {
    console.error(err);
  }
}

function chipNode(k: { term: string; term_en: string | null; article_count: number }): HTMLElement {
  const span = document.createElement('span');
  span.className = 'chip';
  const lang = getLang();
  const label = lang === 'en' && k.term_en ? k.term_en : k.term;
  span.append(label);
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(k.article_count);
  span.append(count);
  return span;
}

async function renderImageFlags(): Promise<void> {
  const list = document.getElementById('image-flags-list');
  if (!list) return;
  // The barometer points already have hero image URLs; we surface the most
  // recent flagged ones by querying the article detail endpoint lazily.
  // For an MVP we simply show the latest 8 articles with a hero image.
  const recent = [...lastPoints]
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .filter((p) => p.hero_image_url)
    .slice(0, 8);
  if (recent.length === 0) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...recent.map((p) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = p.title;
      const meta = document.createElement('span');
      meta.className = 'flag-meta';
      meta.textContent = formatShortDate(p.published_at, getLang());
      li.append(a, meta);
      return li;
    }),
  );
}

function formatShortDate(iso: string, lang: 'fr' | 'en'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

void boot();
