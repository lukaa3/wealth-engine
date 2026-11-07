/**
 * technicals.js — pure functions (browser + Node) that turn daily OHLC candles into the
 * HTF setup the scorer uses: bullish FVG, Fibonacci discount depth, structural support,
 * stop, ~1-month / ~6-month targets and a DCA buy zone.
 * Candles: [{ date: "YYYY-MM-DD", open, high, low, close }] in ascending date order.
 */

const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Aggregate daily candles into weekly (week starts Monday). */
export function toWeekly(daily) {
  const out = [];
  let cur = null, key = null;
  for (const c of daily) {
    const d = new Date(c.date + "T00:00:00Z");
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const k = monday.toISOString().slice(0, 10);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { date: k, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Most recent *meaningful, active* bullish FVG near price.
 * Bullish FVG (3-candle): candle[i].low > candle[i-2].high → zone [candle[i-2].high, candle[i].low].
 * To count, it has to be:
 *   - a real displacement: gap ≥ minGapPct of price and the middle candle's range ≥ 1.3× the prior 10-bar average range
 *   - still valid: no close below the zone since it formed
 *   - near price: price no more than maxDistance above the zone top
 *   - reacting NOW: "Testing" = the latest bar is trading in the zone; "Rejected" = price dipped into the zone within
 *     the last `recentBars` bars and closed back above it. Old touches don't count.
 */
export function findBullishFVG(c, { lookback = 60, maxDistance = 0.06, minGapPct = 0.005, recentBars = 5 } = {}) {
  const n = c.length;
  if (n < 15) return null;
  const last = c[n - 1];
  const range = (x) => x.high - x.low;
  for (let i = n - 1; i >= Math.max(12, n - lookback); i--) {
    const a = c[i - 2], mid = c[i - 1], b = c[i];
    if (!(b.low > a.high)) continue;
    const lo = a.high, hi = b.low;
    if ((hi - lo) / hi < minGapPct) continue; // too small to matter
    const prior = c.slice(i - 12, i - 2);
    const avgRange = prior.reduce((s, x) => s + range(x), 0) / prior.length;
    if (range(mid) < 1.3 * avgRange) continue; // no real displacement
    if (lo > last.close) continue;
    if ((last.close - hi) / last.close > maxDistance) continue; // price has left the zone behind
    let invalid = false;
    for (let j = i + 1; j < n; j++) if (c[j].close < lo) { invalid = true; break; }
    if (invalid) continue;
    const testingNow = last.low <= hi && last.close <= hi;
    let rejected = false;
    for (let j = Math.max(i + 1, n - recentBars); j < n && !rejected; j++) {
      if (c[j].low <= hi) for (let k = j; k < n; k++) if (c[k].close > hi) { rejected = true; break; }
    }
    const status = testingNow ? "Testing" : rejected ? "Rejected" : null;
    if (!status) continue;
    return { status, lo: round(lo), hi: round(hi), index: i };
  }
  return null;
}

/** Swing range over the window and how deep the latest pullback retraced it. */
export function swingAndFib(daily, window = 120) {
  const c = daily.slice(-window);
  if (c.length < 20) return { swingHigh: null, swingLow: null, fib: null };
  let hiIdx = 0;
  c.forEach((x, i) => { if (x.high >= c[hiIdx].high) hiIdx = i; });
  const swingHigh = c[hiIdx].high;
  const before = c.slice(0, hiIdx + 1);
  const swingLow = Math.min(...before.map((x) => x.low));
  const after = c.slice(hiIdx + 1);
  if (!after.length || swingHigh <= swingLow) return { swingHigh, swingLow, fib: null, pullbackLow: null };
  const pullbackLow = Math.min(...after.map((x) => x.low));
  const depth = (swingHigh - pullbackLow) / (swingHigh - swingLow);
  const fib = depth >= 0.786 ? 0.786 : depth >= 0.705 ? 0.705 : depth >= 0.618 ? 0.618 : depth >= 0.5 ? 0.5 : null;
  return { swingHigh, swingLow, fib, pullbackLow, depth };
}

/** Pivot lows (lower than `k` bars either side) near a level → structural support. */
export function hasStructuralSupport(daily, levelLo, levelHi, { window = 160, k = 3, tol = 0.02 } = {}) {
  if (levelLo == null) return false;
  const c = daily.slice(-window, -5);
  for (let i = k; i < c.length - k; i++) {
    let pivot = true;
    for (let j = 1; j <= k; j++) if (c[i].low > c[i - j].low || c[i].low > c[i + j].low) { pivot = false; break; }
    if (!pivot) continue;
    const p = c[i].low;
    if (p >= levelLo * (1 - tol) && p <= levelHi * (1 + tol)) return true;
  }
  return false;
}

/**
 * Full setup for one ticker. Heuristics (tune in one place):
 *   stop      = 1.5% under the FVG low
 *   target1m  = prior swing high if it sits 5–25% above price, else +10%
 *   target6m  = 60% of the way to the Street consensus PT (never below target1m), else +15%
 *   buyZone   = 0.5–0.786 retracement of the swing (DCA zone for a longer hold)
 */
export function deriveSetup({ daily, price, ptConsensus }) {
  if (!daily || daily.length < 30 || !price) return null;
  const weekly = toWeekly(daily);
  let fvg = findBullishFVG(weekly, { lookback: 26, maxDistance: 0.08, minGapPct: 0.01, recentBars: 3 });
  let tf = "Weekly";
  if (!fvg) { fvg = findBullishFVG(daily, { lookback: 60, maxDistance: 0.05, minGapPct: 0.005, recentBars: 5 }); tf = "Daily"; }
  const sw = swingAndFib(daily);
  const zone = fvg ? [fvg.lo, fvg.hi] : sw.pullbackLow ? [sw.pullbackLow, sw.pullbackLow] : [null, null];
  const support = hasStructuralSupport(daily, zone[0], zone[1]);

  const stop = fvg ? round(fvg.lo * 0.985) : null;
  let target1m = price * 1.1;
  if (sw.swingHigh && sw.swingHigh >= price * 1.05 && sw.swingHigh <= price * 1.25) target1m = sw.swingHigh;
  let target6m = ptConsensus && ptConsensus > price ? price + 0.6 * (ptConsensus - price) : price * 1.15;
  target6m = Math.max(target6m, target1m * 1.02);
  const range = sw.swingHigh && sw.swingLow ? sw.swingHigh - sw.swingLow : 0;
  const buyZone = range > 0
    ? [round(sw.swingHigh - 0.786 * range), round(sw.swingHigh - 0.5 * range)]
    : [round(price * 0.9), round(price * 0.97)];

  return {
    fvg: fvg ? { tf, status: fvg.status, lo: fvg.lo, hi: fvg.hi } : { tf: null, status: "None", lo: null, hi: null },
    fib: sw.fib, support, stop, target1m: round(target1m), target6m: round(target6m), buyZone,
    swingHigh: round(sw.swingHigh), swingLow: round(sw.swingLow),
  };
}
