/**
 * fund-compare.mjs — are the index/sector funds worth holding vs just SPY or QQQ?
 * Daily adjusted prices (dividends included) from Yahoo. For each window (10y, 20y): yearly return, worst drop,
 * how bumpy it is, worst calendar year, and how closely it moves with SPY.
 * Mixes are rebalanced once a year. Prints a table to the log and writes public/data/fund-compare.json.
 */
import fs from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const FUNDS = (process.env.FUNDS || "SPY,QQQ,IWM,XLV,VFH,VDC,XLY,XLU").split(",").map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hist(t) {
  for (let a = 0; a < 2; a++) {
    const host = a % 2 ? "query2" : "query1";
    const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${t}?period1=${Math.floor(Date.now() / 1000 - 21.2 * 31557600)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%7Csplit`, { headers: { "User-Agent": UA, Accept: "application/json" } }).catch((e) => (console.warn(t, host, "fetch error:", e.message, e.cause && e.cause.code), null));
    if (res && !res.ok) console.warn(t, host, "HTTP", res.status, (await res.text()).slice(0, 120));
    if (!res || res.status === 429 || res.status >= 500) { await sleep(3000 * (a + 1)); continue; }
    if (!res.ok) throw new Error(t + " HTTP " + res.status);
    const r = (await res.json()).chart.result[0];
    const adj = r.indicators.adjclose[0].adjclose;
    const m = new Map();
    r.timestamp.forEach((ts, i) => { if (adj[i] != null) m.set(new Date(ts * 1000).toISOString().slice(0, 10), adj[i]); });
    return m;
  }
  throw new Error(t + " rate limited");
}

// Fallback: Nasdaq daily closes + cash dividends, reinvested on the ex-date (total return, like adjusted prices).
const NQ = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
const num = (x) => Number(String(x || "").replace(/[$,]/g, ""));
const us2iso = (d) => { const [m, dd, y] = d.split("/"); return `${y}-${m}-${dd}`; };
async function nqJson(url) {
  for (let a = 0; a < 4; a++) {
    const res = await fetch(url, { headers: NQ }).catch(() => null);
    if (res && res.ok) return res.json();
    await sleep(2000 * (a + 1));
  }
  throw new Error("nasdaq " + url);
}
async function histNasdaq(t) {
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 21.2 * 31557600000).toISOString().slice(0, 10);
  const h = await nqJson(`https://api.nasdaq.com/api/quote/${t}/historical?assetclass=etf&fromdate=${from}&limit=9999&todate=${to}`);
  const rows = ((h.data && h.data.tradesTable && h.data.tradesTable.rows) || []).map((r) => [us2iso(r.date), num(r.close)]).filter(([, c]) => c > 0).sort((x, y) => x[0].localeCompare(y[0]));
  const dv = await nqJson(`https://api.nasdaq.com/api/quote/${t}/dividends?assetclass=etf`);
  const divs = new Map();
  ((dv.data && dv.data.dividends && dv.data.dividends.rows) || []).forEach((r) => { if (r.exOrEffDate && r.exOrEffDate !== "N/A") divs.set(us2iso(r.exOrEffDate), (divs.get(us2iso(r.exOrEffDate)) || 0) + num(r.amount)); });
  let units = 1;
  const m = new Map();
  for (const [d, c] of rows) { if (divs.has(d)) units *= 1 + divs.get(d) / c; m.set(d, units * c); }
  console.log(t, "nasdaq:", rows.length, "days,", divs.size, "dividends");
  return m;
}
const data = {};
for (const t of FUNDS) {
  try { data[t] = await hist(t); } catch (e) { data[t] = await histNasdaq(t); }
  await sleep(400);
}
const days = [...data.SPY.keys()].filter((d) => FUNDS.every((t) => data[t].has(d))).sort();
for (const t of FUNDS) console.log(t, "from", [...data[t].keys()][0]);
console.log(`Common history: ${days[0]} → ${days[days.length - 1]} (${days.length} days)`);

function series(weights, from) {
  // value of $1, rebalanced to the weights on the first trading day of each year
  const ds = days.filter((d) => d >= from);
  let units = null, out = [];
  ds.forEach((d, i) => {
    if (!units || d.slice(0, 4) !== ds[i - 1].slice(0, 4)) {
      const v = units ? Object.entries(units).reduce((s, [t, u]) => s + u * data[t].get(d), 0) : 1;
      units = Object.fromEntries(Object.entries(weights).map(([t, w]) => [t, (v * w) / data[t].get(d)]));
    }
    out.push([d, Object.entries(units).reduce((s, [t, u]) => s + u * data[t].get(d), 0)]);
  });
  return out;
}
function stats(s, spyS) {
  const yrs = (Date.parse(s[s.length - 1][0]) - Date.parse(s[0][0])) / 31557600000;
  const cagr = Math.pow(s[s.length - 1][1] / s[0][1], 1 / yrs) - 1;
  let peak = 0, dd = 0;
  const rets = [];
  s.forEach(([, v], i) => { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); if (i) rets.push(v / s[i - 1][1] - 1); });
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252);
  const byYear = {};
  s.forEach(([d, v]) => { const y = d.slice(0, 4); byYear[y] = byYear[y] || [v, v]; byYear[y][1] = v; });
  const ys = Object.keys(byYear).sort();
  let worstYear = null;
  ys.forEach((y, i) => { const start = i ? byYear[ys[i - 1]][1] : byYear[y][0]; const r = byYear[y][1] / start - 1; if (!worstYear || r < worstYear[1]) worstYear = [y, r]; });
  let corr = null;
  if (spyS) {
    const a = rets, b = spyS.slice(1).map(([, v], i) => v / spyS[i][1] - 1);
    const ma = mean, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    corr = sab / Math.sqrt(saa * sbb);
  }
  const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
  return { cagr: r4(cagr), maxDD: r4(dd), vol: r4(vol), worstYear: worstYear && [worstYear[0], r4(worstYear[1])], corrSpy: r4(corr), growth1k: Math.round(1000 * s[s.length - 1][1] / s[0][1]) };
}

const sectors = FUNDS.filter((t) => !["SPY", "QQQ"].includes(t));
const eq = (ts) => Object.fromEntries(ts.map((t) => [t, 1 / ts.length]));
const MIXES = {
  "SPY only": { SPY: 1 },
  "QQQ only": { QQQ: 1 },
  "50% SPY / 50% QQQ": { SPY: 0.5, QQQ: 0.5 },
  ["Your funds, equal amounts (all " + FUNDS.length + ")"]: eq(FUNDS),
  "Your sector funds + IWM only (no SPY/QQQ)": eq(sectors),
  ...Object.fromEntries(FUNDS.filter((t) => t !== "SPY" && t !== "QQQ").map((t) => [t + " alone", { [t]: 1 }])),
};
const end = days[days.length - 1];
const out = { asOf: end, windows: {} };
const pct = (x) => (x == null ? "  n/a" : ((x >= 0 ? " " : "") + (x * 100).toFixed(1) + "%").padStart(7));
for (const yrsBack of [10, 20]) {
  const from = new Date(Date.parse(end) - yrsBack * 31557600000).toISOString().slice(0, 10);
  if (from < days[0]) continue;
  const spyS = series({ SPY: 1 }, from);
  out.windows[yrsBack + "y"] = {};
  console.log(`\n=== Last ${yrsBack} years (${from} → ${end}) — $1,000 grows to / yearly / worst drop / bumpiness / worst year / moves with SPY ===`);
  for (const [name, w] of Object.entries(MIXES)) {
    const st = stats(series(w, from), spyS);
    out.windows[yrsBack + "y"][name] = st;
    console.log(name.padEnd(46) + ("$" + st.growth1k.toLocaleString()).padStart(9) + pct(st.cagr) + pct(st.maxDD) + pct(st.vol) + "  " + st.worstYear[0] + pct(st.worstYear[1]) + "  " + st.corrSpy.toFixed(2));
  }
}
fs.mkdirSync("public/data", { recursive: true });
fs.writeFileSync("public/data/fund-compare.json", JSON.stringify(out, null, 1));
