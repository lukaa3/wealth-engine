/**
 * factors.js — chart-based signals used by the scan, the deep check and the scorer.
 *
 * Why these: across decades of market data, the signals with the most reliable link to returns over the next
 * 3–12 months are price momentum (excluding the most recent month, which tends to reverse), the long-term trend
 * (price vs its 200-day average) and relative strength vs the market. Volatility tells us how risky the ride is.
 */
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const close = (c, n) => (c.length > n ? c[c.length - 1 - n].close : null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Daily candles (oldest → newest) → momentum / trend / risk numbers. Missing history → null fields. */
export function chartFactors(c, price) {
  if (!c || c.length < 30) return null;
  const p = price || c[c.length - 1].close;
  const n = c.length;
  const ret = (from, to = 0) => {
    const a = close(c, Math.min(from, n - 1)), b = to === 0 ? p : close(c, to);
    return a && b && from - to >= 15 ? b / a - 1 : null;
  };
  // 12-1 momentum: return from ~12 months ago to 1 month ago (skips the last month's noise). Uses what history we have (≥ 6 months).
  const mom12_1 = n >= 130 ? ret(Math.min(252, n - 1), 21) : null;
  const ma = (k) => (n >= k ? avg(c.slice(-k).map((x) => x.close)) : null);
  const ma50 = ma(50), ma200 = ma(200);
  const hi52 = Math.max(...c.slice(-252).map((x) => x.high));
  const rets = [];
  for (let i = Math.max(1, n - 63); i < n; i++) if (c[i - 1].close) rets.push(c[i].close / c[i - 1].close - 1);
  const m = avg(rets);
  const vol63 = rets.length > 20 ? Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) : null;
  // 14-day RSI (Wilder) — only used to spot short-term overheating.
  let rsi14 = null;
  if (n > 15) {
    let g = 0, l = 0;
    for (let i = n - 14; i < n; i++) { const d = c[i].close - c[i - 1].close; if (d > 0) g += d; else l -= d; }
    rsi14 = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return {
    mom12_1: r3(mom12_1), mom6: r3(ret(126)), mom3: r3(ret(63)), mom1: r3(ret(21)),
    ma50: ma50 && Math.round(ma50 * 100) / 100, ma200: ma200 && Math.round(ma200 * 100) / 100,
    above200: ma200 ? p > ma200 : null, golden: ma50 && ma200 ? ma50 > ma200 : null,
    ext50: ma50 ? r3(p / ma50 - 1) : null, fromHigh: r3(p / hi52 - 1),
    vol63: r3(vol63), rsi14: rsi14 == null ? null : Math.round(rsi14),
  };
}

/** Percentile rank (0–1) of each row's value within the list; nulls stay null. */
export function percentileRanks(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const out = {};
  if (vals.length < 10) return out;
  for (const r of rows) {
    const v = r[key];
    if (v == null || !isFinite(v)) continue;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < v) lo = mid + 1; else hi = mid; }
    out[r.ticker] = r3(lo / (vals.length - 1));
  }
  return out;
}
