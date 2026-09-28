/*! tick-ticker consent v1
 *
 * One consent choice for tick-ticker.com and every sub-site (gphg., social., blog.).
 * Identical copies live in each site's repo; the canonical one is
 * GPHG/worker/src/assets/consent.js. Change them together.
 *
 * Load it synchronously, BEFORE the GA4 loader/config and the Clarity bootstrap: Consent
 * Mode only works if the 'default' command is queued ahead of gtag('config').
 *
 *  - The choice is stored in tt_consent=granted|denied on .tick-ticker.com, so a visitor
 *    who answers on one host is not asked again on the others (the same scope _ga uses).
 *  - Until someone accepts, GA4 runs with analytics_storage denied (no _ga cookie, only
 *    cookieless pings) and Clarity with analytics_Storage denied (no _clck/_clsk).
 *  - Ad storage is denied permanently: none of these sites use Google Ads or remarketing.
 *  - The banner appears only for visitors who look European (see inScope). Everyone else
 *    gets analytics by default and never sees it; set EVERYWHERE to true to ask everyone.
 *  - Any element with a data-tt-consent attribute reopens the banner ("Cookie settings").
 *
 * No innerHTML, no inline style attributes (styles are set through CSSOM, which the sites'
 * CSPs allow), no network requests of its own.
 */
(function (w, d) {
  "use strict";
  var EVERYWHERE = false;
  var NAME = "tt_consent";
  var MAX_AGE = 15552000; // 180 days, CNIL's recommended lifetime for a recorded choice
  var PRIVACY_URL = "https://tick-ticker.com/privacy";
  var ROOT = "tick-ticker.com";

  var host = location.hostname;
  var onRoot = host === ROOT || host.slice(-(ROOT.length + 1)) === "." + ROOT;
  // workers.dev and localhost cannot take a .tick-ticker.com cookie, so they get a
  // host-only one instead of silently failing to remember anything.
  var domainAttr = onRoot ? "; Domain=." + ROOT : "";

  w.dataLayer = w.dataLayer || [];
  if (typeof w.gtag !== "function")
    w.gtag = function () {
      w.dataLayer.push(arguments);
    };
  // Same stub shape as Clarity's own bootstrap, which keeps it (c[a]=c[a]||...).
  w.clarity =
    w.clarity ||
    function () {
      (w.clarity.q = w.clarity.q || []).push(arguments);
    };

  // Where consent is legally required before analytics: the EEA, the UK and Switzerland.
  // A static page cannot see the visitor's country, so this uses the browser's time zone,
  // erring towards asking: every Europe/* zone, the EU's Atlantic, Caribbean and Indian
  // Ocean territories, Cyprus, and any browser that reports no zone or plain UTC.
  function inScope() {
    if (EVERYWHERE) return true;
    var tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {}
    if (!tz || tz === "UTC" || /^(Europe|Etc)\//.test(tz)) return true;
    return /^(Atlantic\/(Canary|Madeira|Azores|Reykjavik|Faroe)|Asia\/(Nicosia|Famagusta)|Arctic\/Longyearbyen|America\/(Guadeloupe|Martinique|Cayenne|St_Barthelemy|Marigot)|Indian\/(Reunion|Mayotte))$/.test(
      tz,
    );
  }

  function read() {
    var m = d.cookie.match(/(?:^|;\s*)tt_consent=(granted|denied)(?:;|$)/);
    return m ? m[1] : null;
  }

  function signal(v) {
    w.gtag("consent", "update", {
      analytics_storage: v,
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    w.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: v });
  }

  // Withdrawing consent has to remove what accepting created, not just stop new writes.
  // Only first-party cookies can be removed; they are expired both host-only and on the
  // shared domain, since either may have set them.
  function purge() {
    d.cookie.split(";").forEach(function (c) {
      var n = c.split("=")[0].trim();
      if (!/^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat.*|_clck|_clsk)$/.test(n)) return;
      d.cookie = n + "=; Max-Age=0; Path=/";
      if (domainAttr) d.cookie = n + "=; Max-Age=0; Path=/" + domainAttr;
    });
  }

  var stored = read();
  var ask = !stored && inScope();
  var initial = stored || (ask ? "denied" : "granted");
  w.gtag("consent", "default", {
    analytics_storage: initial,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  w.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: initial });

  /* ------------------------------------------------------------------ banner */
  var box = null;
  var returnFocus = null;

  function css(el, s) {
    for (var k in s) el.style[k] = s[k];
    return el;
  }

  function button(label, value) {
    var b = d.createElement("button");
    b.type = "button";
    b.textContent = label;
    // Accept and Reject are deliberately identical: equal prominence is what makes a
    // refusal as easy as an acceptance.
    css(b, {
      font: "inherit",
      fontSize: "14px",
      fontWeight: "500",
      minHeight: "44px",
      minWidth: "96px",
      padding: "0 18px",
      border: "1px solid var(--accent, #1b4f8c)",
      borderRadius: "2px",
      background: "var(--accent, #1b4f8c)",
      color: "#fff",
      cursor: "pointer",
    });
    b.addEventListener("click", function () {
      choose(value);
    });
    return b;
  }

  function build() {
    box = css(d.createElement("div"), {
      position: "fixed",
      left: "16px",
      right: "16px",
      bottom: "16px",
      maxWidth: "640px",
      margin: "0 auto",
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "12px 20px",
      padding: "16px 18px",
      background: "var(--paper, #fcfbf8)",
      color: "var(--ink, #211c15)",
      border: "1px solid var(--paper-line-strong, #d8cfb8)",
      borderRadius: "2px",
      boxShadow: "0 8px 28px rgba(33, 28, 21, 0.14)",
      font: "14px/1.5 var(--sans, system-ui, -apple-system, sans-serif)",
      zIndex: "2147483000",
    });
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Cookie choices");

    var p = css(d.createElement("p"), { margin: "0", flex: "1 1 300px" });
    p.appendChild(
      d.createTextNode(
        "We use Google Analytics and Microsoft Clarity cookies to see how these pages are read. Your choice applies across tick-ticker.com and its sites. ",
      ),
    );
    var a = css(d.createElement("a"), {
      color: "var(--accent, #1b4f8c)",
      textDecoration: "underline",
    });
    a.href = PRIVACY_URL;
    a.textContent = "Privacy";
    p.appendChild(a);

    var row = css(d.createElement("div"), {
      display: "flex",
      gap: "8px",
      flex: "0 0 auto",
    });
    row.appendChild(button("Reject", "denied"));
    row.appendChild(button("Accept", "granted"));

    box.appendChild(p);
    box.appendChild(row);
    d.body.appendChild(box);
  }

  function open(fromControl) {
    if (!box) build();
    box.style.display = "flex";
    if (fromControl) {
      returnFocus = d.activeElement;
      box.querySelector("button").focus();
    }
  }

  function choose(v) {
    d.cookie =
      NAME +
      "=" +
      v +
      "; Max-Age=" +
      MAX_AGE +
      "; Path=/" +
      domainAttr +
      "; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
    signal(v);
    if (v === "denied") purge();
    if (box) box.style.display = "none";
    if (returnFocus && returnFocus.focus) returnFocus.focus();
    returnFocus = null;
  }

  function ready(fn) {
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    if (ask) open(false);
    d.addEventListener("click", function (e) {
      var t =
        e.target && e.target.closest && e.target.closest("[data-tt-consent]");
      if (!t) return;
      e.preventDefault();
      open(true);
    });
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && box && box.style.display !== "none" && read()) {
        box.style.display = "none";
        if (returnFocus && returnFocus.focus) returnFocus.focus();
      }
    });
  });

  w.ttConsent = { open: open, get: read };
})(window, document);
