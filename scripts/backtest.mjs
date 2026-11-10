#!/usr/bin/env node
/**
 * backtest.mjs — does the screener's chart-based scoring actually pick winners?
 *
 * Replays ~10 years month by month on daily charts (Yahoo, dividend/split-adjusted). At each month-end it uses ONLY
 * data up to that day to score every stock the same way the site does, buys the top N equally, holds a month,
 * and repeats. Compared against SPY and an equal-weight basket of the same stocks.
 *
 * What can be tested: momentum & trend (the biggest part of the score) and the FVG setup — they come from price
 * history. What can't (free data has no point-in-time history): analyst estimate revisions, margins, valuation,
 * analyst ratings, insiders. Those parts of the score are left out here.
 *
 * Bias warning: the universe is TODAY's S&P 500 + extras, so stocks that collapsed and left the index are missing.
 * That flatters every strategy, so read results relative to the equal-weight basket of the same stocks.
 *
 * Output: public/data/backtest.json (+ a summary in the log).   Env: BT_YEARS (10), BT_TOP (20), BT_COST (0.001).
 */
import fs from "node:fs";
import path from "node:path";
import { loadUniverse } from "../src/lib/universe.js";
import { scanRow } from "../src/lib/scan.js";
import { percentileRanks } from "../src/lib/factors.js";

const env = process.env;
const YEARS = Number(env.BT_YEARS || 10);
const TOP = Number(env.BT_TOP || 20);
const COST = Number(env.BT_COST || 0.001); // per side, on the part of the portfolio that changes
const GAP = Number(env.YAHOO_GAP_MS || 300);
const UA = "Mozilla/5.0 (compatible; wealth-engine-screener/1.0)";
const OUT = path.resolve("public/data/backtest.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lin = (x, x0, x1, pts) => pts * Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);

/* ---------------- 1. Data: 10 years of adjusted daily candles ---------------- */
async function history(t) {
  const sym = t.replace(/\./g, "-");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS + 1}y&interval=1d&events=div%7Csplit`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const r = (await res.json()).chart.result[0];
    const q = r.indicators.quote[0], adj = r.indicators.adjclose && r.indicators.adjclose[0].adjclose;
    const out = [];
    r.timestamp.forEach((ts, i) => {
      if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) return;
      const k = adj && adj[i] ? adj[i] / q.close[i] : 1; // dividend + split adjustment
      out.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), open: q.open[i] * k, high: q.high[i] * k, low: q.low[i] * k, close: q.close[i] * k, volume: q.volume[i] || 0 });
    });
    return out;
  }
  throw new Error("rate limited");
}

// BT_UNIVERSE=sp500 drops the hand-picked extras (many were added *because* they had already soared = hindsight).
const SP_ONLY = env.BT_UNIVERSE === "sp500";
const universe = (await loadUniverse({ fallback: [], extras: !SP_ONLY })).filter((u) => !u.fund || u.ticker === "SPY");
if (!universe.find((u) => u.ticker === "SPY")) universe.push({ ticker: "SPY", name: "SPY", sector: "Index Funds", fund: true });
console.log(`Backtest (${SP_ONLY ? "S&P 500 only" : "S&P 500 + extras"}): ${universe.length} tickers, ${YEARS} years, top ${TOP}, cost ${COST * 100}% per side`);
const data = {};
let failed = 0;
for (const u of universe) {
  try { data[u.ticker] = await history(u.ticker); } catch (e) { failed++; }
  await sleep(GAP);
}
console.log(`Loaded ${Object.keys(data).length} (${failed} failed)`);
const spy = data.SPY;
if (!spy || spy.length < 600) { console.error("No SPY history; stopping."); process.exit(1); }

// Month-end trading days (SPY calendar), starting once a year of history exists.
const monthEnds = [];
for (let i = 0; i < spy.length - 1; i++) if (spy[i].date.slice(0, 7) !== spy[i + 1].date.slice(0, 7)) monthEnds.push(spy[i].date);
const startIdx = monthEnds.findIndex((d) => d >= spy[260].date);
const dates = monthEnds.slice(startIdx);
const idxOf = {};
for (const [t, c] of Object.entries(data)) { const m = new Map(); c.forEach((x, i) => m.set(x.date, i)); idxOf[t] = m; }
const closeAt = (t, d) => { const i = idxOf[t].get(d); return i == null ? null : data[t][i].close; };

/* ---------------- 2. Score every stock at every month-end ---------------- */
const FVG_SETUP = { "Weekly|Rejected": 6, "Daily|Rejected": 5, "Weekly|Testing": 3, "Daily|Testing": 3 };
const snapshots = []; // per date: rows with factors, scores and forward returns
for (let k = 0; k < dates.length - 1; k++) {
  const d = dates[k];
  const rows = [];
  for (const u of universe) {
    if (u.fund) continue;
    const c = data[u.ticker];
    const i = c && idxOf[u.ticker].get(d);
    if (i == null || i < 260 || c[i].close < 5) continue;
    const r = scanRow(u, { candles: c.slice(Math.max(0, i - 400), i + 1), price: c[i].close });
    if (!r) continue;
    const fwd = (n) => (i + n < c.length ? c[i + n].close / c[i].close - 1 : null);
    const nextD = dates[k + 1];
    const nx = closeAt(u.ticker, nextD);
    rows.push({ ...r, ret1: nx != null ? nx / c[i].close - 1 : null, fwd3: fwd(63), fwd6: fwd(126) });
  }
  if (rows.length < 50) continue;
  const rk12 = percentileRanks(rows, "mom12_1"), rk6 = percentileRanks(rows, "mom6");
  const si = idxOf.SPY.get(d), spyMom3 = si >= 63 ? spy[si].close / spy[si - 63].close - 1 : 0;
  for (const r of rows) {
    // Same formula as scoring.js "Momentum & trend" (30 pts) + FVG setup (≤ 6 pts).
    const m12 = 10 * (rk12[r.ticker] ?? 0.5), m6 = 6 * (rk6[r.ticker] ?? 0.5);
    const rs = r.mom3 != null ? lin(r.mom3 - spyMom3, -0.05, 0.1, 4) : 2;
    const trend = (r.above200 ? 4 : 0) + (r.golden ? 3 : r.golden == null ? 1.5 : 0) + (r.fromHigh != null ? lin(r.fromHigh, -0.35, -0.12, 3) : 1.5);
    r.momScore = m12 + m6 + rs + trend;
    r.setupPts = Math.min(6, (FVG_SETUP[r.fvgTf + "|" + r.fvgStatus] || 0) + (r.entryLive ? 1 : 0));
    r.rs3 = r.mom3 != null ? r.mom3 - spyMom3 : null;
  }
  const sNext = closeAt("SPY", dates[k + 1]), sNow = closeAt("SPY", d);
  snapshots.push({ date: d, rows, spyRet: sNext / sNow - 1 });
}
console.log(`Scored ${snapshots.length} month-ends (${snapshots[0].date} → ${snapshots[snapshots.length - 1].date})`);

/* ---------------- 3. Strategies ---------------- */
const STRATS = {
  "Site momentum & trend score": (rows) => rows.slice().sort((a, b) => b.momScore - a.momScore),
  "Score + FVG timing": (rows) => rows.slice().sort((a, b) => b.momScore + b.setupPts - (a.momScore + a.setupPts)),
  "Score, skip stretched (>15% over 50-day)": (rows) => rows.filter((r) => !(r.ext50 > 0.15)).sort((a, b) => b.momScore - a.momScore),
  "Score, calmer stocks only (lower half volatility)": (rows) => {
    const v = rows.map((r) => r.vol63).filter((x) => x != null).sort((a, b) => a - b), med = v[Math.floor(v.length / 2)];
    return rows.filter((r) => r.vol63 != null && r.vol63 <= med).sort((a, b) => b.momScore - a.momScore);
  },
  "Pure 12-1 momentum": (rows) => rows.filter((r) => r.mom12_1 != null).sort((a, b) => b.mom12_1 - a.mom12_1),
  "FVG only (old method)": (rows) => rows.filter((r) => r.fvgStatus !== "None").sort((a, b) => (b.entryLive - a.entryLive) || b.tech - a.tech || (b.ret20 || 0) - (a.ret20 || 0)),
};

function simulate(pick, top = TOP, everyN = 1) {
  let eq = 1, peak = 1, maxDD = 0, held = [], beat = 0, n = 0;
  const curve = [], monthly = [];
  for (let k = 0; k < snapshots.length; k++) {
    const s = snapshots[k];
    if (k % everyN === 0) {
      const next = pick(s.rows).filter((r) => r.ret1 != null).slice(0, top).map((r) => r.ticker);
      const changed = held.length ? next.filter((t) => !held.includes(t)).length / Math.max(1, next.length) : 1;
      eq *= 1 - changed * COST * 2;
      held = next;
    }
    const by = Object.fromEntries(s.rows.map((r) => [r.ticker, r.ret1]));
    const rets = held.map((t) => by[t]).filter((x) => x != null);
    const r = mean(rets) ?? 0;
    eq *= 1 + r;
    monthly.push(r);
    if (r > s.spyRet) beat++;
    n++;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
    curve.push([s.date, r4(eq)]);
  }
  return stats(monthly, curve, maxDD, beat / n);
}
function stats(monthly, curve, maxDD, beatShare) {
  const yrs = monthly.length / 12;
  const total = curve[curve.length - 1][1];
  const m = mean(monthly), sd = Math.sqrt(mean(monthly.map((x) => (x - m) ** 2)));
  return { cagr: r4(Math.pow(total, 1 / yrs) - 1), total: r4(total - 1), maxDD: r4(maxDD), vol: r4(sd * Math.sqrt(12)),
    sharpe: sd ? Math.round(((m * 12 - 0.03) / (sd * Math.sqrt(12))) * 100) / 100 : null, beatSpy: beatShare == null ? null : r4(beatShare), curve };
}
function benchmark(fn) {
  let eq = 1, peak = 1, maxDD = 0; const curve = [], monthly = [];
  for (const s of snapshots) { const r = fn(s); eq *= 1 + r; monthly.push(r); peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1); curve.push([s.date, r4(eq)]); }
  return stats(monthly, curve, maxDD, null);
}

const results = {
  "SPY (buy and hold)": benchmark((s) => s.spyRet),
  "Equal-weight all stocks": benchmark((s) => mean(s.rows.map((r) => r.ret1).filter((x) => x != null))),
};
for (const [name, fn] of Object.entries(STRATS)) results[name] = simulate(fn);
results["Site score, rebalance every 3 months"] = simulate(STRATS["Site momentum & trend score"], TOP, 3);
results["Site score, top 10"] = simulate(STRATS["Site momentum & trend score"], 10);
results["Site score, top 40"] = simulate(STRATS["Site momentum & trend score"], 40);

// Same tests on each half of the period, to see if the edge is steady or came from one stretch.
const all = snapshots.slice();
const halves = {};
for (const [label, part] of [["first half", all.slice(0, Math.floor(all.length / 2))], ["second half", all.slice(Math.floor(all.length / 2))]]) {
  snapshots.length = 0; snapshots.push(...part);
  halves[label] = { period: [part[0].date, part[part.length - 1].date], results: {
    "SPY (buy and hold)": benchmark((s) => s.spyRet),
    "Equal-weight all stocks": benchmark((s) => mean(s.rows.map((r) => r.ret1).filter((x) => x != null))),
    "Site momentum & trend score": simulate(STRATS["Site momentum & trend score"]),
    "Site score, rebalance every 3 months": simulate(STRATS["Site momentum & trend score"], TOP, 3),
    "Score + FVG timing": simulate(STRATS["Score + FVG timing"]),
    "FVG only (old method)": simulate(STRATS["FVG only (old method)"]),
  } };
}
snapshots.length = 0; snapshots.push(...all);

/* ---------------- 4. Does a higher score mean higher returns? ---------------- */
function quintiles(key, fwdKey) {
  const buckets = [[], [], [], [], []];
  for (const s of snapshots) {
    const rows = s.rows.filter((r) => r[key] != null && r[fwdKey] != null).sort((a, b) => a[key] - b[key]);
    if (rows.length < 25) continue;
    for (let q = 0; q < 5; q++) {
      const part = rows.slice(Math.floor((q * rows.length) / 5), Math.floor(((q + 1) * rows.length) / 5));
      buckets[q].push(mean(part.map((r) => r[fwdKey])));
    }
  }
  return buckets.map((b) => r4(mean(b)));
}
function spearman(rows, key, fwdKey) {
  const ok = rows.filter((r) => r[key] != null && r[fwdKey] != null);
  if (ok.length < 30) return null;
  const rank = (arr, k) => { const s = arr.map((r, i) => [r[k], i]).sort((a, b) => a[0] - b[0]); const out = new Array(arr.length); s.forEach(([, i], j) => (out[i] = j)); return out; };
  const a = rank(ok, key), b = rank(ok, fwdKey), n = ok.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - ma); da += (a[i] - ma) ** 2; db += (b[i] - ma) ** 2; }
  return num / Math.sqrt(da * db);
}
const FACTORS = ["momScore", "mom12_1", "mom6", "mom3", "rs3", "fromHigh", "ext50", "rsi14", "vol63", "setupPts", "tech"];
const ic = {};
for (const f of FACTORS) {
  const one = snapshots.map((s) => spearman(s.rows, f, "ret1")).filter((x) => x != null);
  const three = snapshots.map((s) => spearman(s.rows, f, "fwd3")).filter((x) => x != null);
  ic[f] = { ic1m: r4(mean(one)), ic3m: r4(mean(three)), positiveMonths: r4(one.filter((x) => x > 0).length / one.length) };
}
const above = (flag) => { const v = []; snapshots.forEach((s) => { const g = s.rows.filter((r) => r.above200 === flag && r.fwd3 != null); if (g.length) v.push(mean(g.map((r) => r.fwd3))); }); return r4(mean(v)); };

const out = {
  generatedAt: new Date().toISOString(), years: YEARS, top: TOP, costPerSide: COST,
  period: [snapshots[0].date, snapshots[snapshots.length - 1].date], months: snapshots.length, tickers: Object.keys(data).length - 1,
  universe: SP_ONLY ? "sp500" : "sp500+extras",
  results, halves,
  quintiles: {
    note: "Average forward return by score quintile (Q1 = lowest score, Q5 = highest), averaged over all months",
    momScore_1m: quintiles("momScore", "ret1"), momScore_3m: quintiles("momScore", "fwd3"), momScore_6m: quintiles("momScore", "fwd6"),
    ext50_3m: quintiles("ext50", "fwd3"), vol63_3m: quintiles("vol63", "fwd3"), setupPts_1m: quintiles("setupPts", "ret1"),
  },
  ic: { note: "Average monthly rank correlation between each signal and the next 1 / 3 months' return (0.02–0.05 is useful, >0.05 strong)", ...ic },
  trend200_fwd3: { above: above(true), below: above(false) },
  caveats: [
    "Only the chart-based parts of the score are tested (momentum & trend, FVG). Earnings revisions, quality, valuation and smart money have no free point-in-time history.",
    "Survivorship bias: today's index members only, so delisted losers are missing. Compare strategies to the equal-weight basket, not just to SPY.",
    "Monthly rebalancing at month-end closes, equal weights, " + COST * 100 + "% cost per side on changed positions; no taxes, no slippage beyond that.",
  ],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

const pct = (x) => (x == null ? "  n/a" : ((x * 100).toFixed(1) + "%").padStart(7));
console.log("\nStrategy".padEnd(52) + "  CAGR   Total   MaxDD     Vol  Sharpe  Beat SPY");
for (const [k, v] of Object.entries(results)) console.log(k.padEnd(50) + pct(v.cagr) + pct(v.total).padStart(9) + pct(v.maxDD) + pct(v.vol) + String(v.sharpe).padStart(7) + pct(v.beatSpy));
for (const [h, v] of Object.entries(halves)) {
  console.log(`\n${h} (${v.period[0]} → ${v.period[1]})`);
  for (const [k, x] of Object.entries(v.results)) console.log("  " + k.padEnd(48) + pct(x.cagr) + pct(x.maxDD) + String(x.sharpe).padStart(7));
}
console.log("\nScore quintiles (Q1 low → Q5 high), next 1 / 3 / 6 months:");
console.log(" 1m", out.quintiles.momScore_1m.map(pct).join(" "));
console.log(" 3m", out.quintiles.momScore_3m.map(pct).join(" "));
console.log(" 6m", out.quintiles.momScore_6m.map(pct).join(" "));
console.log(" stretched-vs-50d (3m)", out.quintiles.ext50_3m.map(pct).join(" "));
console.log(" volatility (3m)", out.quintiles.vol63_3m.map(pct).join(" "));
console.log(" FVG setup pts (1m)", out.quintiles.setupPts_1m.map(pct).join(" "));
console.log("\nSignal strength (IC 1m / 3m / % positive months):");
for (const [k, v] of Object.entries(ic)) console.log(" " + k.padEnd(10), String(v.ic1m).padStart(8), String(v.ic3m).padStart(8), pct(v.positiveMonths));
console.log("\nAbove vs below 200-day, avg next 3 months:", pct(out.trend200_fwd3.above), pct(out.trend200_fwd3.below));
