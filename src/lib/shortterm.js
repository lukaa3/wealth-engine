/**
 * shortterm.js — short-term trade setups (days to weeks) found in today's daily chart, each with a full trade plan.
 *
 * Which setups are shown, and their exit rules, come from the short-term backtest (scripts/backtest-short.mjs);
 * SETUPS below carries each one's tested numbers so the site can show them next to every trade idea.
 * Exits are time-based only: every stop-loss variant tested (tight, trailing, 3×ATR "disaster") lowered returns.
 * Sizing: ~22% of the portfolio for short-term trades, split into up to 8 equal slots.
 */

// Tested on 10 years of daily data (2016–2026), $2B+ US stocks, next-day-open entries, 0.1% cost per side.
// "vsSpy" = average trade minus SPY over the same days. Results are flattered by survivorship (only today's stocks).
export const SETUPS = {
  momentum: {
    label: "Momentum swing",
    span: "4 weeks",
    holdDays: 20,
    blurb: "One of today's 20 biggest 1-month gainers among heavily traded stocks, still above its 50-day average. Strong recent winners tend to keep going for a few more weeks.",
    rule: "Buy now, sell 4 weeks later.",
    // top-10 variant (closest to 8 slots); top-20: +1.38% vs SPY, 38% CAGR, -37.6% max drop
    stats: { avg: 0.0272, vsSpy: 0.0157, win: 0.525, pf: 1.43, first: 0.0287, second: 0.0257, cagr10: 0.3235, maxDD: -0.392 },
  },
  gap: {
    label: "Earnings-style gap-up",
    span: "about 2 months",
    holdDays: 40,
    blurb: "Jumped 4%+ at the open on 3x normal volume and held the gain into the close, while above its 200-day average. Big news gaps tend to keep drifting the same way for weeks.",
    rule: "Buy now, sell about 2 months (40 trading days) later.",
    stats: { avg: 0.0311, vsSpy: 0.0117, win: 0.547, pf: 1.53, first: 0.0409, second: 0.0242, cagr10: 0.156, maxDD: -0.384 },
  },
  dip: {
    label: "Quick dip trade",
    span: "2–10 days",
    holdDays: 10,
    blurb: "A momentum leader (top 30% over 6 months) that just had a sharp 2–3 day pullback (RSI-2 under 10) while above its 200-day average. Sell on the first bounce.",
    rule: "Buy now, sell on the first close above the 5-day average (or after 10 trading days).",
    stats: null,
    disabled: true, // refined test: +0.01% per trade vs SPY, ~5,000 trades/yr: no real edge
  },
  breakout: { label: "52-week-high breakout", span: "1 month", holdDays: 20, disabled: true, blurb: "Tested: no edge over simply holding SPY." },
};

/** What the backtest ruled out (shown on the page so the choices are transparent). */
export const RULED_OUT = [
  ["Small caps ($300M–$2B)", "Lost money vs SPY in every setup tested, even though the test flatters them."],
  ["Trades of a week or less", "1-week momentum, 1-week reversal and 5-day dip buys didn't beat simply holding SPY."],
  ["52-week-high breakouts", "About the same as SPY: +0.97% per trade vs SPY's +0.95% over the same days."],
  ["Quick dip trades (2–10 days)", "Buying sharp pullbacks in strong stocks won 64% of the time, but the average trade only matched SPY (+0.01%) and it means ~100 trades a week."],
  ["Selling early after a big drop", "Getting out of a trade after a -5% day, a -10% week, a bad-news drop or a break of the 50-day all did worse per trade than holding to the sell date (gap-ups much worse)."],
  ["Stop-losses", "Tight stops, targets, 'sell half, trail the rest' and even wide 'disaster' stops (3× daily range) all made results worse. Fixed holding periods did best."],
  ["Only trading when the market is strong", "Skipping momentum trades while SPY was below its 200-day average didn't help (same edge, bigger worst drop)."],
  ["Selling part of a long-term winner", "Holding the long-term picks (39% a year) beat selling a third at +15%, +25% or +40% (33–38%)."],
];

const sma = (c, n, i = c.length - 1) => (i + 1 >= n ? c.slice(i - n + 1, i + 1).reduce((a, x) => a + x.close, 0) / n : null);
function atr14(c) {
  if (c.length < 16) return null;
  let s = 0;
  for (let i = c.length - 14; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  return s / 14;
}
function rsi2(c) {
  if (c.length < 20) return null;
  let g = 0, l = 0;
  for (let i = c.length - 19; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close, up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i === c.length - 19) { g = up; l = dn; continue; }
    g = (g + up) / 2; l = (l + dn) / 2;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Today's short-term facts for one stock (daily candles oldest → newest). Light: called for every scanned stock.
 * → { atr, rsi2, sma5, sma50, sma200, gapToday, volX, newHigh, ret21, dollarVol } or null.
 */
export function shortFacts(c) {
  if (!c || c.length < 60) return null;
  const n = c.length, last = c[n - 1], prev = c[n - 2];
  const vol50 = c.slice(-51, -1).reduce((a, x) => a + (x.volume || 0), 0) / 50;
  const dv = c.slice(-50).reduce((a, x) => a + x.close * (x.volume || 0), 0) / 50;
  const prevHi = n > 253 ? Math.max(...c.slice(-253, -1).map((x) => x.close)) : n > 200 ? Math.max(...c.slice(0, -1).map((x) => x.close)) : null;
  return {
    atr: atr14(c), rsi2: rsi2(c), sma5: sma(c, 5), sma50: sma(c, 50), sma200: sma(c, 200),
    gapToday: prev.close ? last.open / prev.close - 1 : null, heldGap: last.close >= last.open,
    volX: vol50 ? (last.volume || 0) / vol50 : null, newHigh: prevHi != null && last.close > prevHi,
    ret21: n > 21 ? last.close / c[n - 22].close - 1 : null, dollarVol: dv,
  };
}

/**
 * Which setups fire today. `rank6` = 6-month momentum percentile (0–1), `momTop` = in today's top 1-month gainers list.
 * Returns setup keys in priority order (strongest backtest first).
 */
export function detectSetups(f, price, { rank6 = null, momTop = false } = {}) {
  if (!f || !price) return [];
  const out = [];
  const above200 = f.sma200 != null && price > f.sma200;
  if (f.gapToday != null && f.gapToday >= 0.04 && f.volX >= 3 && f.heldGap && above200) out.push("gap");
  if (f.newHigh && f.volX >= 1.5 && rank6 != null && rank6 >= 0.7) out.push("breakout");
  if (momTop && f.sma50 != null && price > f.sma50) out.push("momentum");
  if (above200 && f.rsi2 != null && f.rsi2 < 10 && rank6 != null && rank6 >= 0.7) out.push("dip");
  return out.filter((k) => SETUPS[k] && !SETUPS[k].disabled);
}

/** Calendar date about n trading days after `from` (weekends skipped; holidays ignored). */
export function addTradingDays(from, n) {
  const d = new Date(from + "T12:00:00Z");
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}

/**
 * Trade plan: buy at about today's price, the tested exit (time-based, no stop-loss), and a size: each trade gets 1/8 of the short-term budget (budgetPct of the portfolio), so up to 8 trades at once.
 */
export function tradePlanFor(key, price, f, { total = 0, budgetPct = 0.22, earningsDate = null, today = null } = {}) {
  const S = SETUPS[key];
  const sellBy = today ? addTradingDays(today, S.holdDays) : null;
  const size = total > 0 ? (total * budgetPct) / 8 : null;
  let earn = null;
  if (earningsDate && today) {
    const days = Math.round((Date.parse(earningsDate) - Date.parse(today)) / 864e5);
    if (days >= 0 && days <= Math.ceil(S.holdDays * 1.45)) earn = { date: earningsDate, days };
  }
  return { key, label: S.label, span: S.span, holdDays: S.holdDays, rule: S.rule, entry: round2(price),
    sellBy, size, sizePct: total > 0 ? size / total : budgetPct / 8, earnings: earn, stats: S.stats || null, experimental: !!S.experimental };
}
