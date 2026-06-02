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
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import type {
  BarometerPoint,
  SubscriptionPriceRow,
} from "@baromontres/shared/schema";
import { getLang, t } from "./i18n.ts";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Filler,
  zoomPlugin,
);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const SENTIMENT_COLOR = {
  positive: "#2f9e44",
  neutral: "#f0b400",
  negative: "#e03131",
} as const;
const UNKNOWN_COLOR = "#b0a89c";

function sentimentColor(label: string | null | undefined): string {
  if (label === "positive" || label === "neutral" || label === "negative") {
    return SENTIMENT_COLOR[label];
  }
  return UNKNOWN_COLOR;
}

export function renderBarometer(
  canvas: HTMLCanvasElement,
  tooltipEl: HTMLElement,
  points: BarometerPoint[],
  subscription: SubscriptionPriceRow | null,
  onViewChange?: (range: { min: number; max: number } | null) => void,
): Chart | null {
  if (points.length === 0) {
    canvas.replaceWith(noDataNode());
    return null;
  }

  const data = points.map((p) => ({
    x: new Date(p.published_at).getTime(),
    y: p.unit_price_chf,
    point: p,
  }));

  const colors = points.map((p) => sentimentColor(p.sentiment_label));

  const datasets: ChartConfiguration<"line">["data"]["datasets"] = [
    {
      label: "price",
      data: data as unknown as { x: number; y: number }[],
      parsing: false,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: colors,
      pointBorderColor: colors,
      backgroundColor: colors,
      borderColor: colors,
      order: 0,
    },
  ];

  const monthlyMeans = monthlyAverage(points);
  if (monthlyMeans.length >= 2) {
    datasets.push({
      label: "monthly_average",
      data: monthlyMeans as unknown as { x: number; y: number }[],
      parsing: false,
      showLine: true,
      borderColor: "#f59e0b",
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0.35,
      order: 1,
    });
  }

  if (subscription) {
    datasets.push({
      label: "subscription",
      data: [
        { x: data[0]!.x, y: subscription.price_chf },
        { x: data[data.length - 1]!.x, y: subscription.price_chf },
      ] as unknown as { x: number; y: number }[],
      parsing: false,
      showLine: true,
      borderColor: "rgba(160,160,160,0.5)",
      borderDash: [4, 4],
      pointRadius: 0,
      borderWidth: 1.5,
      order: 2,
    });
  }

  const config: ChartConfiguration<"line"> = {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      scales: {
        x: {
          type: "time",
          time: { unit: "month" },
          grid: { display: false },
        },
        y: {
          min: 0,
          title: { display: true, text: "CHF" },
        },
      },
      plugins: {
        tooltip: {
          enabled: false,
          external: (ctx) => renderHtmlTooltip(ctx, tooltipEl, canvas),
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "xy",
            onZoom: ({ chart }) => notifyView(chart, onViewChange),
            onZoomComplete: ({ chart }) => notifyView(chart, onViewChange),
          },
          pan: {
            enabled: true,
            mode: "xy",
            onPan: ({ chart }) => notifyView(chart, onViewChange),
            onPanComplete: ({ chart }) => notifyView(chart, onViewChange),
          },
          limits: {
            x: { minRange: SEVEN_DAYS_MS },
          },
        },
      },
    },
  };

  return new Chart(canvas, config);
}

function notifyView(
  chart: Chart,
  cb: ((range: { min: number; max: number } | null) => void) | undefined,
): void {
  if (!cb) return;
  const scale = chart.scales.x;
  if (!scale) return;
  const min = scale.min;
  const max = scale.max;
  if (typeof min !== "number" || typeof max !== "number") {
    cb(null);
    return;
  }
  cb({ min, max });
}

function renderHtmlTooltip(
  ctx: { tooltip: TooltipModel<"line">; chart: Chart },
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
    : "dot-unknown";
  const sentimentLabel = p.sentiment_label
    ? t(p.sentiment_label)
    : t("unknown");
  const paywall = p.is_paywalled ? t("paywall") : t("free");
  const dateStr = formatDate(p.published_at, lang);

  el.innerHTML = `
    <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
    <div class="tt-meta">${t("tooltipDate")} ${escapeHtml(dateStr)} · ${escapeHtml(paywall)}</div>
    <div class="tt-meta">${t("tooltipPrice")}: <strong>${p.unit_price_chf.toFixed(2)} CHF</strong></div>
    <div class="tt-sentiment"><span class="dot ${sentimentDot}"></span>${escapeHtml(sentimentLabel)}</div>
  `;

  const rect = canvas.getBoundingClientRect();
  const wrapRect =
    (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? rect;
  const left = rect.left - wrapRect.left + tt.caretX + 12;
  const top = rect.top - wrapRect.top + tt.caretY - 12;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.hidden = false;
}

function monthlyAverage(points: BarometerPoint[]): { x: number; y: number }[] {
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const p of points) {
    const key = p.published_at.slice(0, 7); // YYYY-MM
    const b = buckets.get(key) ?? { sum: 0, count: 0 };
    b.sum += p.unit_price_chf;
    b.count += 1;
    buckets.set(key, b);
  }
  const out: { x: number; y: number }[] = [];
  for (const [key, b] of [...buckets.entries()].sort(([a], [c]) =>
    a.localeCompare(c),
  )) {
    if (b.count === 0) continue;
    const [yStr, mStr] = key.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    // Mid-month timestamp (UTC), avoids edge-of-month visual bias.
    const x = Date.UTC(y, m - 1, 15);
    out.push({ x, y: b.sum / b.count });
  }
  return out;
}

function formatDate(iso: string, lang: "fr" | "en"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function noDataNode(): HTMLElement {
  const div = document.createElement("div");
  div.className = "hint";
  div.dataset.i18n = "noData";
  div.textContent = t("noData");
  return div;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
