// Quick probe of free data sources from the GitHub runner (manual "Source check" workflow). Prints what each returns.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const nh = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
const show = async (label, url, headers = nh, n = 1500) => {
  try {
    const r = await fetch(url, { headers });
    const txt = await r.text();
    console.log(`\n=== ${label}: ${r.status}\n${txt.slice(0, n).replace(/\s+/g, " ")}`);
  } catch (e) { console.log(`${label}: FAILED ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
};
await show("peg", "https://api.nasdaq.com/api/analyst/META/peg-ratio", nh, 2500);
await show("earnings-forecast", "https://api.nasdaq.com/api/analyst/META/earnings-forecast", nh, 1800);
await show("summary", "https://api.nasdaq.com/api/quote/META/summary?assetclass=stocks", nh, 2500);
await show("financials cash flow", "https://api.nasdaq.com/api/company/META/financials?frequency=1", nh, 600);
await show("targetprice small cap", "https://api.nasdaq.com/api/analyst/ONDS/targetprice", nh, 400);
await show("sec", "https://data.sec.gov/api/xbrl/companyconcept/CIK0001326801/us-gaap/NetCashProvidedByUsedInOperatingActivities.json",
  { "User-Agent": "wealth-engine screener lukaa3@users.noreply.github.com", Accept: "application/json" }, 300);
