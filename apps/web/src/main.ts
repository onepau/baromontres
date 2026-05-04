import 'chartjs-adapter-date-fns';
import { applyDom, bindLangSwitch, getLang, setLang, t } from './i18n.ts';
import {
  fetchBarometer,
  fetchFlaggedImages,
  fetchKeywords,
  type FlaggedImage,
} from './api.ts';
import { renderBarometer } from './chart.ts';
import type { BarometerPoint } from '@baromontres/shared/schema';
import type { Chart } from 'chart.js';

let chart: Chart | null = null;

async function boot(): Promise<void> {
  setLang(getLang());
  bindLangSwitch(() => {
    applyDom();
    void renderTopics();
    void renderImageFlags();
  });
  await Promise.all([renderChart(), renderTopics(), renderImageFlags()]);
}

async function renderChart(): Promise<void> {
  const canvas = document.getElementById('barometer') as HTMLCanvasElement | null;
  const tooltipEl = document.getElementById('tooltip');
  if (!canvas || !tooltipEl) return;
  try {
    const { points, subscription } = await fetchBarometer();
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
      fetchKeywords('topic', 30, 4),
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
  const empty = document.getElementById('image-flags-empty');
  if (!list) return;
  try {
    const flags = await fetchFlaggedImages(12);
    if (flags.length === 0) {
      list.replaceChildren();
      if (empty) {
        empty.textContent = t('imageFlagsEmpty');
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.replaceChildren(...flags.map(flagNode));
  } catch (err) {
    console.error(err);
  }
}

function flagNode(f: FlaggedImage): HTMLElement {
  const li = document.createElement('li');

  const img = document.createElement('img');
  img.className = 'flag-thumb';
  img.src = f.image_url;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';

  const body = document.createElement('div');
  body.className = 'flag-body';

  const a = document.createElement('a');
  a.href = f.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = f.title;
  body.append(a);

  const meta = document.createElement('div');
  meta.className = 'flag-meta';
  meta.textContent = formatShortDate(f.published_at, getLang());
  body.append(meta);

  const badges = document.createElement('div');
  badges.className = 'flag-badges';
  if (f.pop_culture_source) {
    const b = document.createElement('span');
    b.className = 'badge badge-pop';
    b.textContent = popCultureLabel(f.pop_culture_source);
    badges.append(b);
  }
  if (f.ai_generated_likelihood !== null && f.ai_generated_likelihood >= 0.5) {
    const b = document.createElement('span');
    b.className = 'badge badge-ai';
    b.textContent = `${t('aiBadge')} ${Math.round(f.ai_generated_likelihood * 100)}%`;
    badges.append(b);
  }
  body.append(badges);

  li.append(img, body);
  return li;
}

function popCultureLabel(src: string): string {
  const map: Record<string, string> = {
    peanuts: 'Peanuts',
    tintin: 'Tintin',
    asterix: 'Astérix',
    gaston: 'Gaston',
    calvin_hobbes: 'Calvin & Hobbes',
    other: t('popCultureOther'),
  };
  return map[src] ?? src;
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
