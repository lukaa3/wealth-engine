// Quick probe of free data sources from the GitHub runner (manual "Source check" workflow). Prints statuses only.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const show = async (label, url, init = {}) => {
  try {
    const r = await fetch(url, { redirect: "manual", ...init, headers: { "User-Agent": UA, ...(init.headers || {}) } });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const txt = await r.text();
    console.log(`${label}: ${r.status} cookies=${set.map((c) => c.split("=")[0]).join(",")} loc=${r.headers.get("location") || ""} body=${txt.slice(0, 160).replace(/\s+/g, " ")}`);
    return { r, set, txt };
  } catch (e) { console.log(`${label}: FAILED ${e.cause ? e.cause.code || e.cause.message : e.message}`); return {}; }
};
const a = await show("fc.yahoo.com", "https://fc.yahoo.com");
let cookie = (a.set || []).map((c) => c.split(";")[0]).join("; ");
if (!cookie) { const b = await show("finance.yahoo.com", "https://finance.yahoo.com/quote/AAPL/"); cookie = (b.set || []).map((c) => c.split(";")[0]).join("; "); }
if (!cookie) { const b = await show("login.yahoo.com", "https://login.yahoo.com/"); cookie = (b.set || []).map((c) => c.split(";")[0]).join("; "); }
console.log("cookie names:", cookie.split("; ").map((c) => c.split("=")[0]).join(","));
for (const h of ["query1", "query2"]) {
  const c = await show("getcrumb " + h, `https://${h}.finance.yahoo.com/v1/test/getcrumb`, { headers: { Cookie: cookie } });
  if (c.r && c.r.ok) {
    await show("quoteSummary", `https://${h}.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=financialData&crumb=${encodeURIComponent(c.txt)}`, { headers: { Cookie: cookie } });
    break;
  }
}
await show("quoteSummary no crumb", "https://query2.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=financialData");
const nh = { Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
await show("nasdaq targetprice", "https://api.nasdaq.com/api/analyst/AAPL/targetprice", { headers: nh });
await show("nasdaq peg", "https://api.nasdaq.com/api/analyst/AAPL/peg-ratio", { headers: nh });
await show("nasdaq ratings", "https://api.nasdaq.com/api/analyst/AAPL/ratings", { headers: nh });
await show("sec companyfacts", "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", { headers: { "User-Agent": "wealth-engine-screener github.com/lukaa3/wealth-engine" } });
