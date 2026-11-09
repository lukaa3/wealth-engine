// Temporary probe of free data sources from the GitHub runner.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const nh = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
const show = async (label, path, n = 2500) => {
  try {
    const r = await fetch("https://api.nasdaq.com/api/" + path, { headers: nh });
    console.log(`\n=== ${label}: ${r.status}\n${(await r.text()).slice(0, n).replace(/\s+/g, " ")}`);
  } catch (e) { console.log(label, "FAILED", e.message); }
};
await show("earnings-forecast", "analyst/META/earnings-forecast", 3000);
await show("earnings-surprise", "company/META/earnings-surprise", 1500);
await show("estimate-momentum", "analyst/META/estimate-momentum", 1500);
await show("ratings", "analyst/META/ratings", 1500);
await show("insider", "company/META/insider-trades?limit=5&type=ALL&sortColumn=lastDate&sortOrder=DESC", 800);
const j = await (await fetch("https://api.nasdaq.com/api/company/META/financials?frequency=1", { headers: nh })).json();
const rt = j.data && j.data.financialRatiosTable;
console.log("\n=== ratios headers", JSON.stringify(rt && rt.headers));
(rt && rt.rows || []).forEach((r) => console.log("  " + r.value1 + " | " + r.value2));
const inc = j.data && j.data.incomeStatementTable;
(inc && inc.rows || []).forEach((r) => console.log("  INC " + r.value1 + " | " + r.value2));
await show("news", "news/topic/articlebysymbol?q=META|stocks&offset=0&limit=5&fallback=true", 1200);
