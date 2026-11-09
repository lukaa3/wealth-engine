/**
 * scan.js — the cheap first pass over the whole universe (chart data only).
 * For every stock: momentum (1-week / 1-month / 3-month returns, volume surge, distance from the 52-week high)
 * and the HTF setup (bullish FVG, Fib depth, support). The best setups and the strongest movers then get the
 * full "deep check" (valuation, analysts, insiders, AI) within the free API quotas.
 */
import { deriveSetup } from "./technicals.js";
import { chartFactors } from "./factors.js";

const FVG_POINTS = { "Weekly|Rejected": 20, "Daily|Rejected": 16, "Weekly|Testing": 10, "Daily|Testing": 8 };
const ret = (c, n) => (c.length > n && c[c.length - 1 - n].close ? c[c.length - 1].close / c[c.length - 1 - n].close - 1 : null);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** One stock's chart → scan row. */
export function scanRow(meta, data) {
  const c = data.candles || [];
  if (c.length < 30) return null;
  const last = c[c.length - 1];
  const price = data.price || last.close;
  const vols = c.slice(-21, -1).map((x) => x.volume || 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const hi52 = Math.max(...c.slice(-252).map((x) => x.high));
  const setup = deriveSetup({ daily: c, price });
  const tFvg = setup ? FVG_POINTS[setup.fvg.tf + "|" + setup.fvg.status] || 0 : 0;
  const tFib = setup && setup.fib != null ? (setup.fib >= 0.618 ? 10 : setup.fib === 0.5 ? 4 : 0) : 0;
  const tSup = setup && setup.support ? 5 : 0;
  let entryLive = false;
  if (setup && setup.fvg.status === "Rejected" && setup.stop != null) {
    const mid = (setup.fvg.lo + setup.fvg.hi) / 2;
    const rr = (setup.target1m - mid) / (mid - setup.stop);
    entryLive = price <= setup.fvg.hi * 1.03 && rr >= 2;
  }
  const f = chartFactors(c, price) || {};
  return {
    ticker: meta.ticker, name: data.name || meta.name, sector: meta.sector, fund: !!meta.fund, price: r3(price),
    ret5: r3(ret(c, 5)), ret20: r3(ret(c, 20)), ret60: r3(ret(c, 60)),
    volRatio: avgVol ? r3((last.volume || 0) / avgVol) : null,
    fromHigh: r3(price / hi52 - 1),
    mom12_1: f.mom12_1 ?? null, mom6: f.mom6 ?? null, mom3: f.mom3 ?? null, ma50: f.ma50 ?? null, ma200: f.ma200 ?? null,
    above200: f.above200 ?? null, golden: f.golden ?? null, ext50: f.ext50 ?? null, vol63: f.vol63 ?? null, rsi14: f.rsi14 ?? null,
    fvgTf: setup ? setup.fvg.tf : null, fvgStatus: setup ? setup.fvg.status : "None",
    fvgLo: setup ? setup.fvg.lo : null, fvgHi: setup ? setup.fvg.hi : null,
    fib: setup ? setup.fib : null, support: !!(setup && setup.support),
    tech: tFvg + tFib + tSup, entryLive,
  };
}

/**
 * Which stocks get the deep check (valuation, earnings estimates, quality, analysts, insiders):
 *   1. your holdings + the watchlist (always),
 *   2. the strongest momentum + trend leaders (12-1 and 6-month momentum rank, above the 200-day average),
 *   3. the biggest 1-month movers on rising volume (so APP-style runs get a look),
 *   4. live FVG entries among decent-trend names (timing setups),
 *   5. a rotating slice of the rest, so steady long-term compounders get checked every few weeks even when
 *      their momentum is quiet (results stay on the site for up to a week).
 * `ranks` = { mom12: {T: 0–1}, mom6: {T: 0–1} } from percentileRanks().
 */
export function pickDeepSet(rows, { deepN = 80, momentumN = 10, leadersN = 35, fvgN = 5, rotateN = 15, always = [], ranks = {}, day = 0 } = {}) {
  const have = new Set(rows.map((r) => r.ticker));
  const chosen = new Set(always.filter((t) => have.has(t)));
  const add = (t) => { if (chosen.size < deepN) chosen.add(t); };
  const liquid = rows.filter((r) => r.price >= 5 && !r.fund); // funds/ETFs are held, not picked
  const pre = (r) => 0.5 * ((ranks.mom12 || {})[r.ticker] ?? 0.5) + 0.3 * ((ranks.mom6 || {})[r.ticker] ?? 0.5) + (r.above200 ? 0.2 : 0);
  const leaders = liquid.slice().sort((a, b) => pre(b) - pre(a)).slice(0, leadersN);
  const movers = liquid.filter((r) => r.ret20 != null && (r.volRatio || 0) >= 1).sort((a, b) => b.ret20 - a.ret20).slice(0, momentumN);
  const entries = liquid.filter((r) => r.entryLive && r.above200 !== false).sort((a, b) => pre(b) - pre(a)).slice(0, fvgN);
  [...leaders, ...movers, ...entries].forEach((r) => add(r.ticker));
  const rest = liquid.filter((r) => !chosen.has(r.ticker)).sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  if (rest.length) {
    const start = (day * rotateN) % rest.length;
    for (let i = 0; i < Math.min(rotateN, rest.length); i++) add(rest[(start + i) % rest.length].ticker);
  }
  return Array.from(chosen);
}
