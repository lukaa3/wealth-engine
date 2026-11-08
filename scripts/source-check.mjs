// Quick probe of free data sources from the GitHub runner (manual "Source check" workflow).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const nh = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
for (const t of ["META", "ONDS"]) {
  const j = await (await fetch(`https://api.nasdaq.com/api/company/${t}/financials?frequency=1`, { headers: nh })).json();
  for (const k of ["cashFlowTable", "balanceSheetTable", "financialRatiosTable"]) {
    const tb = j.data && j.data[k];
    console.log(`\n=== ${t} ${k} headers=${tb && JSON.stringify(tb.headers)}`);
    (tb && tb.rows || []).forEach((r) => console.log("  " + r.value1 + " | " + r.value2 + " | " + r.value3));
  }
}
const s = await (await fetch("https://api.nasdaq.com/api/analyst/ONDS/peg-ratio", { headers: nh })).json();
console.log("\nONDS peg:", JSON.stringify(s.data && { peg: s.data.pegr, per: s.data.per && s.data.per.peRatioChart, gr: s.data.gr }).slice(0, 600));
const etf = await fetch("https://api.nasdaq.com/api/analyst/SPY/targetprice", { headers: nh });
console.log("SPY target:", etf.status, (await etf.text()).slice(0, 200));
