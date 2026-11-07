/**
 * scan.js — the cheap first pass over the whole universe (chart data only).
 * For every stock: momentum (1-week / 1-month / 3-month returns, volume surge, distance from the 52-week high)
 * and the HTF setup (bullish FVG, Fib depth, support). The best setups and the strongest movers then get the
 * full "deep check" (valuation, analysts, insiders, AI) within the free API quotas.
 */
import { deriveSetup } from "./technicals.js";

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
  return {
    ticker: meta.ticker, name: data.name || meta.name, sector: meta.sector, price: r3(price),
    ret5: r3(ret(c, 5)), ret20: r3(ret(c, 20)), ret60: r3(ret(c, 60)),
    volRatio: avgVol ? r3((last.volume || 0) / avgVol) : null,
    fromHigh: r3(price / hi52 - 1),
    fvgTf: setup ? setup.fvg.tf : null, fvgStatus: setup ? setup.fvg.status : "None",
    fvgLo: setup ? setup.fvg.lo : null, fvgHi: setup ? setup.fvg.hi : null,
    fib: setup ? setup.fib : null, support: !!(setup && setup.support),
    tech: tFvg + tFib + tSup, entryLive,
  };
}

/**
 * Which stocks get the deep check:
 *   1. the watchlist (always),
 *   2. the strongest chart setups (live FVG entries first, then technical score, then 1-month momentum),
 *   3. the top momentum runners (biggest 1-month gains on rising volume), so big movers get a look too.
 */
export function pickDeepSet(rows, { deepN = 30, momentumN = 10, watchlist = [] } = {}) {
  const chosen = new Set(watchlist.filter((t) => rows.some((r) => r.ticker === t)));
  const liquid = rows.filter((r) => r.price >= 5);
  const movers = liquid.filter((r) => r.ret20 != null && (r.volRatio || 0) >= 1).sort((a, b) => b.ret20 - a.ret20).slice(0, momentumN);
  // Prefer live entries, then technical score, then the stronger 3-month trend (leaders pulling back beat laggards).
  const setups = liquid.slice().sort((a, b) => (b.entryLive - a.entryLive) || (b.tech - a.tech) || ((b.ret60 || 0) - (a.ret60 || 0)));
  for (const r of movers) if (chosen.size < deepN) chosen.add(r.ticker);
  for (const r of setups) { if (chosen.size >= deepN) break; chosen.add(r.ticker); }
  return Array.from(chosen);
}
