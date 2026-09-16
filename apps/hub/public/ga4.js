/**
 * GA4 for tick-ticker.com, routed first-party through Cloudflare's Google tag gateway.
 * (Full reasoning lives in the GPHG repo's ANALYTICS_PLAN.md.)
 *
 * One file rather than an inline block in each entry HTML: index.html (fr) and
 * en/index.html both need this, and the last time the tag was duplicated across those two
 * files it went wrong in a way nobody noticed for a day — see the comment where the old
 * snippet used to sit. A shared file cannot drift between them.
 *
 * transport_url is what makes collection first-party. Serving the loader from /analytics
 * is only half the job: without it gtag still beacons to region1.google-analytics.com
 * regardless of where the loader came from. That was the state of this site from
 * 2026-08-28 until this landed — one tag, but no first-party collection.
 *
 * Google Signals is off deliberately: it beacons to stats.g.doubleclick.net, which
 * transport_url does not redirect, so it would be the one remaining third-party request.
 * The cost is demographics and remarketing audiences. Note this site DOES run AdSense —
 * if remarketing audiences are ever wanted, this is the line to revisit, and it needs
 * stats.g.doubleclick.net allowed alongside.
 */
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag("js", new Date());
gtag("config", "G-9ZCDZDCE1P", {
  transport_url: window.location.origin + "/analytics",
  first_party_collection: true,
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
});
