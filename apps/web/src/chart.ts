import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Filler,
  type ChartConfiguration,
  type TooltipModel,
} from 'chart.js';
import type { BarometerPoint, SubscriptionPriceRow } from '@baromontres/shared/schema';
import { getLang, t } from './i18n.ts';

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

const SENTIMENT_COLOR: Record<string, string> = {
  positive: '#2f9e44',
  neutral: '#f0b400',
  negative: '#e03131',
};
const UNKNOWN_COLOR = '#b0a89c';

export function renderBarometer(
  canvas: HTMLCanvasElement,
  tooltipEl: HTMLElement,
  points: BarometerPoint[],
  subscription: SubscriptionPriceRow | null,
): Chart | null {
  if (points.length === 0) {
    canvas.replaceWith(noDataNode());
    return null;
  }

  const data = points.map((p) => ({
    x: p.published_at,
    y: p.unit_price_chf,
    point: p,
  }));

  const colors = points.map((p) =>
    p.sentiment_label ? SENTIMENT_COLOR[p.sentiment_label] ?? UNKNOWN_COLOR : UNKNOWN_COLOR,
  );

  const datasets: ChartConfiguration<'line'>['data']['datasets'] = [
    {
      label: 'price',
      data: data as unknown as { x: number; y: number }[],
      parsing: false,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: colors,
      pointBorderColor: colors,
    },
  ];

  if (subscription) {
    datasets.push({
      label: 'subscription',
      data: [
        { x: data[0]!.x, y: subscription.price_chf },
        { x: data[data.length - 1]!.x, y: subscription.price_chf },
      ] as unknown as { x: number; y: number }[],
      parsing: false,
      showLine: true,
      borderColor: 'rgba(120,120,120,0.6)',
      borderDash: [4, 4],
      pointRadius: 0,
      borderWidth: 1.5,
    });
  }

  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'month' },
          grid: { display: false },
        },
        y: {
          beginAtZero: false,
          title: { display: true, text: 'CHF' },
        },
      },
      plugins: {
        tooltip: {
          enabled: false,
          external: (ctx) => renderHtmlTooltip(ctx, tooltipEl, canvas),
        },
      },
    },
  };

  return new Chart(canvas, config);
}

function renderHtmlTooltip(
  ctx: { tooltip: TooltipModel<'line'>; chart: Chart },
  el: HTMLElement,
  canvas: HTMLCanvasElement,
): void {
  const tt = ctx.tooltip;
  if (tt.opacity === 0) {
    el.hidden = true;
    return;
  }
  const dp = tt.dataPoints?.[0];
  const raw = dp?.raw as { point?: BarometerPoint } | undefined;
  const p = raw?.point;
  if (!p) {
    el.hidden = true;
    return;
  }
  const lang = getLang();
  const sentimentDot = p.sentiment_label
    ? `dot-${p.sentiment_label}`
    : 'dot-unknown';
  const sentimentLabel = p.sentiment_label ? t(p.sentiment_label) : t('unknown');
  const paywall = p.is_paywalled ? t('paywall') : t('free');
  const dateStr = formatDate(p.published_at, lang);

  el.innerHTML = `
    <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
    <div class="tt-meta">${t('tooltipDate')} ${escapeHtml(dateStr)} · ${escapeHtml(paywall)}</div>
    <div class="tt-meta">${t('tooltipPrice')}: <strong>${p.unit_price_chf.toFixed(2)} CHF</strong></div>
    <div class="tt-sentiment"><span class="dot ${sentimentDot}"></span>${escapeHtml(sentimentLabel)}</div>
  `;

  const rect = canvas.getBoundingClientRect();
  const wrapRect = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? rect;
  const left = rect.left - wrapRect.left + tt.caretX + 12;
  const top = rect.top - wrapRect.top + tt.caretY - 12;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.hidden = false;
}

function formatDate(iso: string, lang: 'fr' | 'en'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function noDataNode(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'hint';
  div.dataset.i18n = 'noData';
  div.textContent = t('noData');
  return div;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
