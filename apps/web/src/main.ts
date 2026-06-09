import "chartjs-adapter-date-fns";
import { applyDom, bindLangSwitch, getLang, setLang, t } from "./i18n.ts";
import {
  fetchBarometer,
  fetchBrands,
  fetchFlaggedImages,
  fetchKeywords,
  fetchPaywall,
  fetchSentimentPanel,
  type BrandLeaderboardRow,
  type FlaggedImage,
  type SentimentPanel,
} from "./api.ts";
import { renderBarometer } from "./chart.ts";
import type { BarometerPoint } from "@baromontres/shared/schema";
import type { Chart } from "chart.js";

let chart: Chart | null = null;
let allPoints: BarometerPoint[] = [];
let currentSubscription: number | null = null;
let currentPaywallPeriod = "monthly";
let brandRows: BrandLeaderboardRow[] = [];
let sentimentPanel: SentimentPanel | null = null;

const PAYWALL_PERIOD_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  annual: 365,
  annual_supporter: 365,
};

function observeSection(id: string, render: () => Promise<void>): void {
  const el = document.getElementById(id);
  if (!el) return;
  const obs = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        obs.disconnect();
        void render();
      }
    },
    { rootMargin: "200px" },
  );
  obs.observe(el);
}

async function boot(): Promise<void> {
  setLang(getLang());
  bindLangSwitch(() => {
    applyDom();
    void renderTopics();
    void renderImageFlags();
    void renderPaywallMeter(currentPaywallPeriod);
    void renderBrandLeaderboard();
    // void renderSentimentPanel(); // on hold
  });
  bindResetZoom();
  bindRangeFilter();
  bindPaywallPeriods();
  bindBrandTabs();
  await Promise.all([renderChart(), renderPaywallMeter()]);
  observeSection("brand-list", () => renderBrandLeaderboard());
  observeSection("topics", () => renderTopics());
  observeSection("image-flags-list", () => renderImageFlags());
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function bindResetZoom(): void {
  const btn = document.getElementById("reset-zoom");
  btn?.addEventListener("click", () => {
    chart?.resetZoom();
    setActiveRange("all");
  });
}

function bindRangeFilter(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".range-filter button",
  )) {
    btn.addEventListener("click", () => {
      const range = btn.dataset.range;
      if (!range) return;
      applyRange(range);
      setActiveRange(range);
    });
  }
}

function applyRange(range: string): void {
  if (!chart || allPoints.length === 0) return;
  if (range === "all") {
    chart.resetZoom();
    return;
  }
  const months: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "1y": 12,
  };
  const m = months[range];
  if (!m) return;
  const last = new Date(
    allPoints[allPoints.length - 1]!.published_at,
  ).getTime();
  if (!Number.isFinite(last)) return;
  const start = new Date(last);
  start.setMonth(start.getMonth() - m);
  chart.zoomScale("x", { min: start.getTime(), max: last }, "default");
}

function setActiveRange(range: string): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".range-filter button",
  )) {
    btn.setAttribute(
      "aria-pressed",
      btn.dataset.range === range ? "true" : "false",
    );
  }
}

async function renderChart(): Promise<void> {
  const canvas = document.getElementById(
    "barometer",
  ) as HTMLCanvasElement | null;
  const tooltipEl = document.getElementById("tooltip");
  const resetBtn = document.getElementById("reset-zoom");
  if (!canvas || !tooltipEl) return;
  try {
    const { points, subscription } = await fetchBarometer();
    allPoints = points;
    currentSubscription = subscription?.price_chf ?? null;
    chart?.destroy();
    chart = renderBarometer(
      canvas,
      tooltipEl,
      points,
      subscription,
      syncMetaForView,
    );
    if (resetBtn) resetBtn.hidden = chart === null;
    setActiveRange("all");
    updateMeta(points, currentSubscription);
  } catch (err) {
    console.error(err);
    document.getElementById("meta-period")!.textContent = "—";
  }
}

function syncMetaForView(range: { min: number; max: number } | null): void {
  if (!range) {
    updateMeta(allPoints, currentSubscription);
    return;
  }
  const visible = allPoints.filter((p) => {
    const t = new Date(p.published_at).getTime();
    return Number.isFinite(t) && t >= range.min && t <= range.max;
  });
  updateMeta(visible, currentSubscription);
}

function updateMeta(
  points: BarometerPoint[],
  subscription: number | null,
): void {
  const period = document.getElementById("meta-period")!;
  const avg = document.getElementById("meta-average")!;
  const count = document.getElementById("meta-count")!;
  const sub = document.getElementById("meta-subscription")!;
  if (points.length === 0) {
    period.textContent = "—";
    avg.textContent = "—";
    count.textContent = "0";
    sub.textContent =
      subscription !== null ? `${subscription.toFixed(2)} CHF` : "—";
    return;
  }
  const sorted = [...points].sort((a, b) =>
    a.published_at.localeCompare(b.published_at),
  );
  const start = sorted[0]!.published_at;
  const end = sorted[sorted.length - 1]!.published_at;
  const lang = getLang();
  period.textContent = `${formatShortDate(start, lang)} — ${formatShortDate(end, lang)}`;
  const mean =
    points.reduce((acc, p) => acc + p.unit_price_chf, 0) / points.length;
  avg.textContent = `${mean.toFixed(2)} CHF`;
  count.textContent = String(points.length);
  sub.textContent =
    subscription !== null ? `${subscription.toFixed(2)} CHF` : "—";
}

async function renderPaywallMeter(period = "monthly"): Promise<void> {
  const days = PAYWALL_PERIOD_DAYS[period] ?? 30;
  const since = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const stats = await fetchPaywall(since);
    const fmt = (n: number) =>
      new Intl.NumberFormat(getLang() === "fr" ? "fr-CH" : "en-CH", {
        style: "currency",
        currency: "CHF",
        maximumFractionDigits: 0,
      }).format(n);
    const tierPrice = stats.subscription_tiers[period] ?? null;
    const multiple =
      tierPrice && tierPrice > 0
        ? stats.total_unit_price_chf / tierPrice
        : null;
    setText("paywall-total", fmt(stats.total_unit_price_chf));
    setText("paywall-sub", tierPrice != null ? fmt(tierPrice) : "—");
    setText(
      "paywall-multiple",
      multiple != null ? `${multiple.toFixed(1)}×` : "—",
    );
  } catch (err) {
    console.error(err);
  }
}

function bindPaywallPeriods(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".paywall-periods button",
  )) {
    btn.addEventListener("click", () => {
      const period = btn.dataset.period ?? "monthly";
      currentPaywallPeriod = period;
      void renderPaywallMeter(period);
      for (const b of document.querySelectorAll<HTMLButtonElement>(
        ".paywall-periods button",
      )) {
        b.setAttribute(
          "aria-pressed",
          b.dataset.period === period ? "true" : "false",
        );
      }
    });
  }
}

async function renderBrandLeaderboard(view = "coverage"): Promise<void> {
  if (brandRows.length === 0) {
    try {
      brandRows = await fetchBrands(20, 3);
    } catch (err) {
      console.error(err);
      return;
    }
  }
  let rows = [...brandRows];
  if (view === "positive")
    rows.sort((a, b) => b.net_sentiment - a.net_sentiment);
  else if (view === "negative") {
    rows = rows.filter((r) => r.net_sentiment < 0);
    rows.sort((a, b) => a.net_sentiment - b.net_sentiment);
  } else rows.sort((a, b) => b.article_count - a.article_count);

  const list = document.getElementById("brand-list");
  if (!list) return;
  const en = getLang() === "en";
  list.replaceChildren(
    ...rows.slice(0, 12).map((r, i) => {
      const li = document.createElement("li");

      const rank = document.createElement("span");
      rank.className = "brand-rank";
      rank.textContent = String(i + 1);

      const name = document.createElement("span");
      name.className = "brand-name";
      name.textContent = en && r.term_en ? r.term_en : r.term;

      const countEl = document.createElement("span");
      countEl.className = "brand-count";
      countEl.textContent = String(r.article_count);

      const pct = Math.round(r.net_sentiment * 100);
      const net = document.createElement("span");
      net.className = "brand-net";
      net.textContent = pct > 0 ? `+${pct}` : String(pct);
      net.dataset.positive = pct > 0 ? "true" : "false";
      net.dataset.negative = pct < 0 ? "true" : "false";

      li.append(rank, name, countEl, net);
      return li;
    }),
  );
}

function bindBrandTabs(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".brand-tabs button",
  )) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view ?? "coverage";
      void renderBrandLeaderboard(view);
      for (const b of document.querySelectorAll<HTMLButtonElement>(
        ".brand-tabs button",
      )) {
        b.setAttribute(
          "aria-pressed",
          b.dataset.view === view ? "true" : "false",
        );
      }
    });
  }
}

async function renderTopics(): Promise<void> {
  const topicsEl = document.getElementById("topics");
  if (!topicsEl) return;
  try {
    const topics = await fetchKeywords("topic", 30, 4);
    topicsEl.replaceChildren(...topics.map(chipNode));
  } catch (err) {
    console.error(err);
  }
}

function chipNode(k: {
  term: string;
  term_en: string | null;
  article_count: number;
}): HTMLElement {
  const span = document.createElement("span");
  span.className = "chip";
  const lang = getLang();
  const label = lang === "en" && k.term_en ? k.term_en : k.term;
  span.append(label);
  return span;
}

async function renderImageFlags(): Promise<void> {
  const list = document.getElementById("image-flags-list");
  const empty = document.getElementById("image-flags-empty");
  if (!list) return;
  try {
    const flags = await fetchFlaggedImages(50);
    const withSource = flags.filter((f) => {
      if (!f.source_clue) return false;
      const m = f.source_clue.match(/https?:\/\/\S+/);
      return m ? isStaticImageSource(m[0]) : false;
    });
    if (withSource.length === 0) {
      list.replaceChildren();
      if (empty) {
        empty.textContent = t("imageFlagsEmpty");
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.replaceChildren(...withSource.slice(0, 12).map(flagNode));
  } catch (err) {
    console.error(err);
  }
}

const NON_STATIC_HOSTS =
  /\b(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|dailymotion\.com|twitch\.tv)\b/i;

function isStaticImageSource(url: string): boolean {
  try {
    return !NON_STATIC_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function flagNode(f: FlaggedImage): HTMLElement {
  const li = document.createElement("li");

  const imgLink = document.createElement("a");
  imgLink.href = f.url;
  imgLink.target = "_blank";
  imgLink.rel = "noopener";
  imgLink.setAttribute("aria-label", f.title);

  const img = document.createElement("img");
  img.className = "flag-thumb";
  img.src = f.image_url;
  img.alt = f.title;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  imgLink.append(img);

  const body = document.createElement("div");
  body.className = "flag-body";

  const meta = document.createElement("div");
  meta.className = "flag-meta";
  meta.textContent = formatShortDate(f.published_at, getLang());
  body.append(meta);

  const badges = document.createElement("div");
  badges.className = "flag-badges";
  if (f.source_clue) {
    const urlMatch = f.source_clue.match(/https?:\/\/\S+/);
    if (urlMatch && isStaticImageSource(urlMatch[0])) {
      const a = document.createElement("a");
      a.className = "badge badge-source";
      a.href = urlMatch[0];
      a.target = "_blank";
      a.rel = "noopener";
      a.title = f.source_clue;
      a.textContent = t("sourceClueBadge");
      badges.append(a);
    }
  }
  body.append(badges);

  li.append(imgLink, body);
  return li;
}

function formatShortDate(iso: string, lang: "fr" | "en"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

async function renderSentimentPanel(): Promise<void> {
  const list = document.getElementById("source-list");
  if (!list) return;
  try {
    if (!sentimentPanel) {
      sentimentPanel = await fetchSentimentPanel();
    }
    const panel = sentimentPanel;
    const en = getLang() === "en";
    list.replaceChildren(
      ...panel.sources.map((src) => {
        const li = document.createElement("li");

        const nameSpan = document.createElement("span");
        nameSpan.className = "source-name";
        nameSpan.textContent = src.name;

        const langBadge = document.createElement("span");
        langBadge.className = "source-lang";
        langBadge.textContent = src.lang.toUpperCase();
        nameSpan.append(langBadge);

        const barWrap = document.createElement("span");
        barWrap.className = "source-bar-wrap";
        const bar = document.createElement("span");
        bar.className = "source-bar";
        const pct = Math.round(Math.abs(src.net_sentiment) * 100);
        bar.style.width = `${pct}%`;
        bar.dataset.positive = src.net_sentiment > 0 ? "true" : "false";
        bar.dataset.negative = src.net_sentiment < 0 ? "true" : "false";
        bar.dataset.neutral = src.net_sentiment === 0 ? "true" : "false";
        barWrap.append(bar);

        const countSpan = document.createElement("span");
        countSpan.className = "source-count";
        countSpan.textContent = String(src.article_count);

        const netSpan = document.createElement("span");
        netSpan.className = "source-net";
        const netPct = Math.round(src.net_sentiment * 100);
        netSpan.textContent = netPct > 0 ? `+${netPct}%` : `${netPct}%`;
        netSpan.dataset.positive = netPct > 0 ? "true" : "false";
        netSpan.dataset.negative = netPct < 0 ? "true" : "false";

        li.append(nameSpan, barWrap, countSpan, netSpan);
        void en; // lang used indirectly via nameSpan above
        return li;
      }),
    );
  } catch (err) {
    console.error(err);
  }
}

void boot();
