#!/usr/bin/env node
/**
 * backtest-short.mjs — which short-term setups (days to weeks) actually made money, and does
 * "sell a third at a target, hold the rest" beat plain holding for the long-term picks?
 *
 * Daily data (Yahoo, adjusted), ~10 years. Signals use only data up to that day's close; trades enter at the NEXT open.
 * Costs: 0.1% per side for $2B+ stocks, 0.25% per side for small caps ($300M–$2B).
 * Universe: today's listed US stocks $300M+ priced $3+ (survivorship bias: delisted losers are missing; compare
 * setups against each other and against holding the same stocks, not just against SPY).
 *
 * Setups tested (long only):
 *   dip      RSI(2) < 10 while above the 200-day, exit on a close above the 5-day average or after 10 days
 *   dip3     3 down closes in a row in a strong uptrend (50 > 200-day, top-30% 6-month momentum), exit after 5 days
 *   breakout new 52-week closing high on 1.5x+ volume, top-30% 6-month momentum; exits: 20 days / 2-ATR stop + 3-ATR target / split
 *   gap      gap up 4%+ on 3x+ volume that holds into the close (earnings-style jump); exits like breakout
 *   mom      weekly: top 1-month gainers among liquid stocks above their 50-day, hold 1 or 4 weeks
 *   rev      weekly: biggest 1-month losers still above their 200-day, hold 1 week
 * Output: public/data/backtest-short.json + log.   Env: BT_YEARS (10), BT_MINCAP (3e8), YAHOO_GAP_MS (250).
 */
import fs from "node:fs";
import path from "node:path";
import { loadListedStocks } from "../src/lib/universe.js";

const env = process.env;
const YEARS = Number(env.BT_YEARS || 10);
const MINCAP = Number(env.BT_MINCAP || 3e8);
const GAP = Number(env.YAHOO_GAP_MS || 250);
const OUT = path.resolve("public/data/backtest-short.json");
const UA = "Mozilla/5.0 (compatible; wealth-engine-screener/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);

/* ------------------------------ data ------------------------------ */
async function history(t) {
  const sym = t.replace(/\./g, "-");
  for (let a = 0; a < 3; a++) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS + 1}y&interval=1d`, { headers: { "User-Agent": UA } });
    if (res.status === 429) { await sleep(5000 * (a + 1)); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const r = (await res.json()).chart.result[0];
    const q = r.indicators.quote[0], adj = r.indicators.adjclose && r.indicators.adjclose[0].adjclose;
    const d = [], o = [], h = [], l = [], c = [], v = [];
    r.timestamp.forEach((ts, i) => {
      if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) return;
      const k = adj && adj[i] ? adj[i] / q.close[i] : 1;
      d.push(new Date(ts * 1000).toISOString().slice(0, 10)); o.push(q.open[i] * k); h.push(q.high[i] * k); l.push(q.low[i] * k); c.push(q.close[i] * k); v.push(q.volume[i] || 0);
    });
    const F = (a) => Float64Array.from(a);
    return { d, o: F(o), h: F(h), l: F(l), c: F(c), v: F(v) };
  }
  throw new Error("rate limited");
}

let listed = [];
try { listed = await loadListedStocks({ minCap: MINCAP, minPrice: 3 }); } catch (e) { console.error("No stock list:", e.message); process.exit(1); }
listed.push({ ticker: "SPY", marketCap: 1e13 });
console.log(`Short-term backtest: ${listed.length} stocks ($${MINCAP / 1e6}M+, $3+), ${YEARS} years`);
const S = {};
let failed = 0;
for (const u of listed) {
  try { const x = await history(u.ticker); if (x.c.length > 300) S[u.ticker] = { ...x, small: u.marketCap < 2e9 }; } catch (e) { failed++; }
  await sleep(GAP);
}
console.log(`Loaded ${Object.keys(S).length} (${failed} failed)`);
const spy = S.SPY;
if (!spy) { console.error("No SPY"); process.exit(1); }

/* --------------------------- indicators --------------------------- */
function sma(a, n) { const o = new Float64Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function rsi(a, n) {
  const o = new Float64Array(a.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function atr(h, l, c, n) {
  const o = new Float64Array(c.length).fill(NaN); let s = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    s = i <= n ? s + tr / n : (s * (n - 1) + tr) / n; if (i >= n) o[i] = s;
  }
  return o;
}
// Highest close of the previous n days (monotonic deque, O(length)).
function rollMaxPrev(a, n) {
  const o = new Float64Array(a.length).fill(NaN), dq = [];
  let head = 0;
  for (let i = 0; i < a.length; i++) {
    while (head < dq.length && dq[head] <= i - n - 1) head++;
    if (i >= n) o[i] = a[dq[head]];
    while (dq.length > head && a[dq[dq.length - 1]] <= a[i]) dq.pop();
    dq.push(i);
  }
  return o;
}
for (const x of Object.values(S)) {
  x.s5 = sma(x.c, 5); x.s20 = sma(x.c, 20); x.s50 = sma(x.c, 50); x.s200 = sma(x.c, 200);
  x.rsi2 = rsi(x.c, 2); x.atr = atr(x.h, x.l, x.c, 14); x.hi252 = rollMaxPrev(x.c, 252); x.av50 = sma(x.v, 50);
  x.dv50 = sma(x.c.map((p, i) => p * x.v[i]), 50); // dollar volume (Float64Array.map keeps the type)
}

// Master calendar = SPY trading days; per-stock index lookup.
const days = spy.d, D = days.length;
const START = 260;
for (const x of Object.values(S)) {
  const m = new Map(); x.d.forEach((d, i) => m.set(d, i));
  x.at = new Int32Array(D).fill(-1); days.forEach((d, k) => { const i = m.get(d); if (i != null) x.at[k] = i; });
  if (x !== spy) delete x.d; // dates aren't needed after alignment (saves memory)
}
const ret = (x, i, n) => (i - n >= 0 ? x.c[i] / x.c[i - n] - 1 : NaN);
// 6-month momentum rank per day (among $2B+ and small separately is overkill; use all liquid stocks), computed weekly to save time.
const tick = Object.keys(S).filter((t) => t !== "SPY");
const rank6 = {}; // rank6[t] = Float32Array(D)
tick.forEach((t) => (rank6[t] = new Float32Array(D).fill(NaN)));
for (let k = START; k < D; k += 5) {
  const vals = [];
  for (const t of tick) { const x = S[t], i = x.at[k]; if (i >= 126) vals.push([t, ret(x, i, 126)]); }
  vals.sort((a, b) => a[1] - b[1]);
  vals.forEach(([t], j) => { const r = j / Math.max(1, vals.length - 1); for (let q = k; q < Math.min(D, k + 5); q++) rank6[t][q] = r; });
}

/* ------------------------------ trades ------------------------------ */
// Exit styles for event setups. Returns { exitI, px } given entry index e (entry at open[e]) in stock arrays.
function exitTime(x, e, n) { const j = Math.min(x.c.length - 1, e + n - 1); return { j, px: x.c[j] }; }
function exitAtr(x, e, n, sig) {
  const a = x.atr[sig] || x.c[sig] * 0.03, entry = x.o[e], stop = entry - 2 * a, tgt = entry + 3 * a;
  for (let j = e; j < Math.min(x.c.length, e + n); j++) {
    if (x.l[j] <= stop) return { j, px: Math.min(x.o[j], stop) };
    if (x.h[j] >= tgt) return { j, px: Math.max(x.o[j], tgt) };
  }
  const j = Math.min(x.c.length - 1, e + n - 1); return { j, px: x.c[j] };
}
// Split: sell half at +2 ATR, move stop to breakeven, trail the rest under the 10-day low (max 60 days).
function exitSplit(x, e, n, sig) {
  const a = x.atr[sig] || x.c[sig] * 0.03, entry = x.o[e];
  let stop = entry - 2 * a, half = null;
  for (let j = e; j < Math.min(x.c.length, e + Math.max(n, 60)); j++) {
    if (x.l[j] <= stop) { const px = Math.min(x.o[j], stop); return { j, px: half == null ? px : (half + px) / 2 }; }
    if (half == null && x.h[j] >= entry + 2 * a) { half = Math.max(x.o[j], entry + 2 * a); stop = Math.max(stop, entry); }
    if (half != null && j >= e + 10) { let lo = Infinity; for (let q = j - 9; q <= j; q++) lo = Math.min(lo, x.l[q]); stop = Math.max(stop, lo); }
  }
  const j = Math.min(x.c.length - 1, e + Math.max(n, 60) - 1); return { j, px: half == null ? x.c[j] : (half + x.c[j]) / 2 };
}

function runEvent(name, signal, exit, { cooldown = 0 } = {}) {
  const trades = [];
  for (const t of tick) {
    const x = S[t];
    let nextFree = 0;
    for (let k = START; k < D - 1; k++) {
      const i = x.at[k];
      if (i < 252 || i + 1 >= x.c.length || i < nextFree) continue;
      if (!(x.dv50[i] >= 2e6) || x.c[i] < 3) continue; // tradable: $2M+/day
      const pri = signal(x, i, t, k);
      if (pri == null || pri === false) continue;
      const e = i + 1, ex = exit(x, e, i);
      const cost = x.small ? 0.0025 : 0.001;
      const r = ex.px / x.o[e] - 1 - 2 * cost;
      const sk = k + 1, ek = Math.min(D - 1, k + 1 + (ex.j - e));
      const spyR = spy.c[ek] / spy.o[sk] - 1;
      trades.push({ t, k: sk, ek, r, ex: r - spyR, hold: ex.j - e + 1, small: x.small, pri: typeof pri === "number" ? pri : 0 });
      nextFree = ex.j + 1 + cooldown;
    }
  }
  return { name, trades };
}

// Weekly cross-sectional setups (enter Monday open, hold N weeks).
function runWeekly(name, pick, holdDays, topN = 20) {
  const trades = [];
  for (let k = START; k < D - holdDays - 1; k += 5) {
    const cands = [];
    for (const t of tick) {
      const x = S[t], i = x.at[k];
      if (i < 252 || i + holdDays >= x.c.length || !(x.dv50[i] >= 5e6) || x.c[i] < 5) continue;
      const s = pick(x, i, t, k);
      if (s != null) cands.push([s, t, i]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    for (const [, t, i] of cands.slice(0, topN)) {
      const x = S[t], e = i + 1, j = Math.min(x.c.length - 1, e + holdDays - 1);
      const cost = x.small ? 0.0025 : 0.001;
      const r = x.c[j] / x.o[e] - 1 - 2 * cost;
      const sk = k + 1, ek = Math.min(D - 1, k + holdDays);
      trades.push({ t, k: sk, ek, r, ex: r - (spy.c[ek] / spy.o[sk] - 1), hold: holdDays, small: x.small, pri: 0 });
    }
  }
  return { name, trades };
}

const up200 = (x, i) => x.c[i] > x.s200[i];
const strong = (x, i, t, k) => x.s50[i] > x.s200[i] && x.c[i] > x.s50[i] && rank6[t][k] >= 0.7;
const SETUPS = [
  runEvent("Dip: RSI(2)<10 above 200-day → exit above 5-day (max 10d)", (x, i) => up200(x, i) && x.rsi2[i] < 10 && x.rsi2[i],
    (x, e) => { for (let j = e; j < Math.min(x.c.length, e + 10); j++) if (x.c[j] > x.s5[j]) return { j, px: x.c[j] }; const j = Math.min(x.c.length - 1, e + 9); return { j, px: x.c[j] }; }),
  runEvent("Dip in leader: 3 down days, strong trend → hold 5d", (x, i, t, k) => strong(x, i, t, k) && x.c[i] < x.c[i - 1] && x.c[i - 1] < x.c[i - 2] && x.c[i - 2] < x.c[i - 3],
    (x, e) => exitTime(x, e, 5)),
  ...[["20d", (x, e) => exitTime(x, e, 20)], ["ATR stop/target", (x, e, s) => exitAtr(x, e, 30, s)], ["split: ½ at +2 ATR, trail rest", (x, e, s) => exitSplit(x, e, 20, s)]].map(([lab, fn]) =>
    runEvent("Breakout: new 52-wk high on 1.5x volume → " + lab, (x, i, t, k) => x.c[i] > x.hi252[i] && x.v[i] >= 1.5 * x.av50[i] && rank6[t][k] >= 0.7, fn, { cooldown: 5 })),
  ...[["20d", (x, e) => exitTime(x, e, 20)], ["40d", (x, e) => exitTime(x, e, 40)], ["split: ½ at +2 ATR, trail rest", (x, e, s) => exitSplit(x, e, 20, s)]].map(([lab, fn]) =>
    runEvent("Gap-up 4%+ on 3x volume, held → " + lab, (x, i) => x.o[i] >= x.c[i - 1] * 1.04 && x.v[i] >= 3 * x.av50[i] && x.c[i] >= x.o[i] && up200(x, i), fn, { cooldown: 5 })),
  runWeekly("Momentum: top 1-mo gainers above 50-day → hold 1 wk", (x, i) => (x.c[i] > x.s50[i] ? ret(x, i, 21) : null), 5),
  runWeekly("Momentum: top 1-mo gainers above 50-day → hold 4 wks", (x, i) => (x.c[i] > x.s50[i] ? ret(x, i, 21) : null), 20),
  runWeekly("Reversal: biggest 1-mo losers above 200-day → hold 1 wk", (x, i) => (up200(x, i) ? -ret(x, i, 21) : null), 5),
];

/* ---------------------------- summaries ---------------------------- */
const half = Math.floor((START + D) / 2);
function summarize(tr) {
  if (!tr.length) return null;
  const rs = tr.map((x) => x.r), wins = rs.filter((x) => x > 0), loss = rs.filter((x) => x <= 0);
  const pf = loss.length ? wins.reduce((a, b) => a + b, 0) / -loss.reduce((a, b) => a + b, 0) : null;
  const yrs = (D - START) / 252;
  return { trades: tr.length, perYear: Math.round(tr.length / yrs), avg: r4(mean(rs)), avgVsSpy: r4(mean(tr.map((x) => x.ex))), win: r4(wins.length / tr.length),
    avgHold: Math.round(mean(tr.map((x) => x.hold))), profitFactor: pf && Math.round(pf * 100) / 100,
    first: r4(mean(tr.filter((x) => x.k < half).map((x) => x.r))), second: r4(mean(tr.filter((x) => x.k >= half).map((x) => x.r))) };
}
// Portfolio: 10 equal slots; when more signals than free slots, take the strongest 6-month momentum first.
function portfolio(tr, slots = 10) {
  const byDay = {};
  tr.forEach((x) => (byDay[x.k] = byDay[x.k] || []).push(x));
  let eq = 1, peak = 1, dd = 0;
  const open = [];
  let busyDays = 0;
  for (let k = START; k < D; k++) {
    for (let q = open.length - 1; q >= 0; q--) if (open[q].ek <= k) { eq += open[q].size * open[q].r; open.splice(q, 1); }
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    const today = (byDay[k] || []).slice().sort((a, b) => (rank6[b.t][b.k - 1] || 0) - (rank6[a.t][a.k - 1] || 0));
    for (const x of today) { if (open.length >= slots) break; if (open.find((o) => o.t === x.t)) continue; open.push({ ...x, size: eq / slots }); }
    if (open.length) busyDays++;
  }
  open.forEach((o) => (eq += o.size * o.r));
  const yrs = (D - START) / 252;
  return { cagr: r4(Math.pow(Math.max(eq, 1e-9), 1 / yrs) - 1), maxDD: r4(dd), exposure: r4(busyDays / (D - START)) };
}
const out = { generatedAt: new Date().toISOString(), years: YEARS, period: [days[START], days[D - 1]], stocks: tick.length, setups: [] };
const spyCagr = Math.pow(spy.c[D - 1] / spy.c[START], 252 / (D - START)) - 1;
for (const s of SETUPS) {
  const all = summarize(s.trades), big = summarize(s.trades.filter((x) => !x.small)), small = summarize(s.trades.filter((x) => x.small));
  out.setups.push({ name: s.name, all, big, small, portfolio10: portfolio(s.trades), portfolio10Big: portfolio(s.trades.filter((x) => !x.small)) });
}

/* ----------- Long-term picks: sell a third at +X% vs plain holding (quarterly rebalance) ----------- */
const bigT = tick.filter((t) => !S[t].small);
const monthEnds = [];
for (let k = START; k < D - 1; k++) if (days[k].slice(0, 7) !== days[k + 1].slice(0, 7)) monthEnds.push(k);
const qEnds = monthEnds.filter((_, j) => j % 3 === 0);
function longTerm(rule) {
  let eq = 1, peak = 1, dd = 0;
  for (let q = 0; q < qEnds.length - 1; q++) {
    const k = qEnds[q], k2 = qEnds[q + 1];
    const rows = [];
    for (const t of bigT) {
      const x = S[t], i = x.at[k], i2 = x.at[k2];
      if (i < 252 || i2 < 0 || x.c[i] < 5) continue;
      rows.push({ t, i, i2, m12: x.c[i - 21] / x.c[i - 252] - 1, m6: ret(x, i, 126), a200: x.c[i] > x.s200[i], g: x.s50[i] > x.s200[i] });
    }
    const rk = (key) => { const s = rows.slice().sort((a, b) => a[key] - b[key]); s.forEach((r, j) => (r[key + "R"] = j / (s.length - 1))); };
    rk("m12"); rk("m6");
    rows.forEach((r) => (r.score = 16 * r.m12R + 6 * r.m6R + (r.a200 ? 4 : 0) + (r.g ? 3 : 0)));
    const top = rows.sort((a, b) => b.score - a.score).slice(0, 20);
    const rets = top.map((r) => {
      const x = S[r.t], entry = x.c[r.i];
      if (!rule) return x.c[r.i2] / entry - 1;
      let soldAt = null;
      for (let j = r.i + 1; j <= r.i2; j++) if (x.h[j] >= entry * (1 + rule)) { soldAt = Math.max(x.o[j], entry * (1 + rule)); break; }
      const endR = x.c[r.i2] / entry - 1;
      return soldAt == null ? endR : (soldAt / entry - 1) / 3 + (endR * 2) / 3;
    });
    eq *= 1 + mean(rets) - 0.002;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
  }
  const yrs = (qEnds[qEnds.length - 1] - qEnds[0]) / 252;
  return { cagr: r4(Math.pow(eq, 1 / yrs) - 1), maxDD: r4(dd) };
}
out.longTermSplit = { hold: longTerm(null), sellThirdAt15: longTerm(0.15), sellThirdAt25: longTerm(0.25), sellThirdAt40: longTerm(0.4) };
out.spyCagr = r4(spyCagr);
out.caveats = [
  "Today's listed stocks only (survivorship bias): delisted losers are missing, which flatters every setup, small caps most.",
  "Entries at the next day's open, exits at closes or stop/target prices; costs 0.1%/side ($2B+), 0.25%/side (small caps). No taxes.",
  "Earnings dates aren't in the free data, so the 'gap-up' setup stands in for earnings jumps.",
];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

const pct = (x) => (x == null ? "   n/a" : ((x * 100).toFixed(2) + "%").padStart(8));
console.log(`\nSPY CAGR ${pct(spyCagr)} · period ${out.period.join(" → ")}`);
console.log("Setup".padEnd(66) + "  trades/yr  avg/trade  vs SPY   win   hold  PF   1st-half 2nd-half | big avg  small avg | port CAGR  maxDD  exposure | big-only CAGR");
for (const s of out.setups) {
  const a = s.all || {};
  console.log(s.name.slice(0, 64).padEnd(66) + String(a.perYear).padStart(8) + pct(a.avg) + pct(a.avgVsSpy) + pct(a.win) + String(a.avgHold).padStart(5) + String(a.profitFactor).padStart(6)
    + pct(a.first) + pct(a.second) + " |" + pct(s.big && s.big.avg) + pct(s.small && s.small.avg) + " |" + pct(s.portfolio10.cagr) + pct(s.portfolio10.maxDD) + pct(s.portfolio10.exposure) + " |" + pct(s.portfolio10Big.cagr));
}
console.log("\nLong-term top 20 (quarterly) — plain hold vs sell 1/3 at a target:");
for (const [k, v] of Object.entries(out.longTermSplit)) console.log("  " + k.padEnd(16) + " CAGR" + pct(v.cagr) + "  maxDD" + pct(v.maxDD));
