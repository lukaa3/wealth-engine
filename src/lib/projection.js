/**
 * projection.js — where your portfolio could be in 1 month, 3 months and 1 year.
 *
 * Method (the standard "single-index" risk model + lognormal growth, as used for portfolio risk ranges):
 *  - Each holding i has a market beta β_i and a total volatility σ_i (from the last ~3 months of daily moves, blended
 *    with a long-run level so a calm stretch doesn't make it look safer than it is). Its own, company-specific
 *    risk is what's left: σ_ε,i² = σ_i² − β_i²·σ_m².
 *  - Portfolio risk: σ_p² = (Σ w_i β_i)²·σ_m² + Σ w_i²·σ_ε,i². Company-specific risk partly cancels out across
 *    holdings; market risk doesn't.
 *  - Expected return per holding: cash rate + β × the market's long-run premium (CAPM), plus a small extra for
 *    long-term picks and short-term trades: only a QUARTER of what the 10-year backtests showed, because backtests
 *    always look better than real life (survivorship, costs, taxes, luck).
 *  - Value at time t: V₀·exp((μ − σ²/2)·t + z·σ·√t). Percentiles come from z (normal), so the bands are honest
 *    "1 in 4" and "1 in 20" ranges, not guesses.
 * News isn't turned into a number (it doesn't predict reliably); it shows up through volatility: stocks moving a
 * lot right now get wider ranges.
 */

export const ASSUME = {
  cashRate: 0.04,        // what cash / T-bills pay per year
  marketPremium: 0.05,   // stocks' long-run return above cash (S&P 500 ≈ 9%/yr total)
  marketVolLongRun: 0.17,// the S&P 500's long-run yearly volatility
  stockVolLongRun: 0.35, // a typical single stock's yearly volatility
  shrink: 0.25,          // share of the backtested edge we count on
  edges: {               // yearly edge over the market in the backtests (before the haircut)
    longPick: 0.17,      // long-term picks (score 65+): ~32%/yr vs SPY ~15%
    momentum: 0.2,       // momentum trades: ~+1.6% per 4-week trade vs SPY, ~12 trades a year
    gap: 0.07,           // gap-up trades: ~+1.1% per ~2-month trade vs SPY, ~6 a year
  },
  correlation: 0.5,      // stock ↔ market, used to estimate beta when none is published
};

// Betas for common funds (published, long-run); others are estimated from volatility.
const FUND_BETA = { SPY: 1, VOO: 1, IVV: 1, VTI: 1.02, QQQ: 1.15, QQQM: 1.15, IWM: 1.15, DIA: 0.95, XLK: 1.2, XLV: 0.7, XLU: 0.55, VDC: 0.6, XLP: 0.6, XLY: 1.15, VFH: 1.1, XLF: 1.1 };

const clampP = (x, a, b) => Math.max(a, Math.min(b, x));
const blendVol = (recent, longRun) => (recent > 0 ? Math.sqrt(0.6 * recent * recent + 0.4 * longRun * longRun) : longRun);

/** Inverse of the standard normal CDF (Acklam), for percentiles. */
function zOf(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** Standard normal CDF. */
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export const BANDS = [0.05, 0.25, 0.5, 0.75, 0.95];
export const PROJ_HORIZONS = [
  { key: "1M", label: "1 month", years: 21 / 252 },
  { key: "3M", label: "3 months", years: 63 / 252 },
  { key: "1Y", label: "1 year", years: 1 },
];

/**
 * rows: the portfolio rows from analyzePortfolio (value, weight, stock, chart, term, trade, fund, ticker).
 * priceBook: scan items by ticker (needs SPY's vol63).
 */
export function projectPortfolio(rows, priceBook = {}, { assume = ASSUME } = {}) {
  const total = rows.reduce((a, r) => a + (r.value || 0), 0);
  if (!(total > 0)) return null;
  const spyVol = priceBook.SPY && priceBook.SPY.vol63;
  const sm = blendVol(spyVol || 0, assume.marketVolLongRun);

  const items = rows.filter((r) => r.value > 0).map((r) => {
    const w = r.value / total;
    if (r.ticker === "CASH") return { ticker: "CASH", label: "Cash", kind: "cash", value: r.value, w, beta: 0, vol: 0, idio: 0, mu: assume.cashRate, alpha: 0 };
    const pb = priceBook[r.ticker] || r.chart || {};
    const isFund = !!(r.fund || pb.fund || (r.sector === "Index Funds"));
    const recent = (r.stock && r.stock.factors && r.stock.factors.vol63) || pb.vol63 || 0;
    const vol = blendVol(recent, isFund ? assume.marketVolLongRun * 1.1 : assume.stockVolLongRun);
    let beta = isFund ? (FUND_BETA[r.ticker] ?? clampP(0.85 * vol / sm, 0.4, 1.6)) : r.stock && r.stock.beta > 0 ? r.stock.beta : clampP(assume.correlation * vol / sm, 0.3, 2.5);
    beta = clampP(beta, 0, 3);
    const idio = Math.max(vol * vol - beta * beta * sm * sm, 0.15 * vol * vol); // keep some company-specific risk
    // Extra return: only for things the backtests support, and only a quarter of it.
    let kind = isFund ? "index" : "long", alpha = 0;
    const score = r.stock ? r.stock.composite : pb.sc;
    if (r.term === "short" && r.trade) { kind = "short"; alpha = assume.shrink * (assume.edges[r.trade.setup] ?? assume.edges.momentum); }
    else if (!isFund && score != null && score >= 65) { kind = "pick"; alpha = assume.shrink * assume.edges.longPick; }
    else if (!isFund) kind = "other";
    const mu = assume.cashRate + beta * assume.marketPremium + alpha;
    return { ticker: r.ticker, label: r.ticker, kind, value: r.value, w, beta, vol, idio, mu, alpha, score };
  });

  const bp = items.reduce((a, x) => a + x.w * x.beta, 0);
  const varMarket = bp * bp * sm * sm;
  const varIdio = items.reduce((a, x) => a + x.w * x.w * x.idio, 0);
  const sigma = Math.sqrt(varMarket + varIdio);
  const mu = items.reduce((a, x) => a + x.w * x.mu, 0);
  // Risk share of each holding (Euler allocation: sums to 100%).
  items.forEach((x) => {
    const covWithP = x.beta * bp * sm * sm + x.w * x.idio;
    x.riskShare = sigma > 0 ? (x.w * covWithP) / (sigma * sigma) : 0;
  });

  const at = (years) => {
    const drift = (mu - sigma * sigma / 2) * years, sd = sigma * Math.sqrt(years);
    const v = Object.fromEntries(BANDS.map((p) => [p, total * Math.exp(drift + zOf(p) * sd)]));
    return { years, values: v, mean: total * Math.exp(mu * years), probUp: sd > 0 ? 1 - phi(-drift / sd) : 1, probDown10: sd > 0 ? phi((Math.log(0.9) - drift) / sd) : 0 };
  };
  const horizons = Object.fromEntries(PROJ_HORIZONS.map((h) => [h.key, { ...h, ...at(h.years) }]));
  // A smooth path for the chart: weekly points out to a year.
  const path = [];
  for (let d = 0; d <= 252; d += 5) path.push({ day: d, ...at(d / 252) });
  if (path[path.length - 1].day !== 252) path.push({ day: 252, ...at(1) });

  const byKind = {};
  items.forEach((x) => { const k = byKind[x.kind] || (byKind[x.kind] = { kind: x.kind, w: 0, mu: 0, riskShare: 0 }); k.w += x.w; k.mu += x.w * x.mu; k.riskShare += x.riskShare; });
  Object.values(byKind).forEach((k) => (k.mu = k.w ? k.mu / k.w : 0));

  return { total, mu, sigma, beta: bp, marketVol: sm, diversified: varMarket / (varMarket + varIdio || 1), items, horizons, path, byKind, assume };
}
