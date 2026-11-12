#!/usr/bin/env node
/**
 * update-screener.mjs — background job (run by .github/workflows/deploy.yml on a schedule).
 *
 *  0. Market scan: daily charts for every US stock worth $2B+ and priced $5+ (~1,500–2,000, Nasdaq's list,
 *     plus the S&P 500 and extras) from Yahoo's free chart feed → momentum (ranked vs the whole scan), trend,
 *     volatility and FVG setup for each → public/data/scan.json. Your holdings, the momentum leaders, big movers,
 *     live FVG entries, then the stocks with the oldest full check (DEEP_N, default 400) go on to step 1.
 *  1. Deep check: price targets, analyst consensus, EPS estimate revisions, earnings surprises, margins, cash flow
 *     (Nasdaq, free) plus Finnhub / FMP / Alpha Vantage to fill gaps. Stocks fully checked in the last 7 days stay
 *     in the pool with today's price and chart, so the whole market is covered about every 5 days.
 *     The full pool lives in cache/pool.json (kept between runs by the Actions cache, not committed); the site gets
 *     the stocks scoring 50+ plus your holdings.
 *  2. Detects bullish FVGs, Fib depth and support, and derives stops, 1-mo / 6-mo targets and DCA zones.
 *  3. Scores everything with the same scorer the UI uses.
 *  4. Writes public/data/{screener,analyst,insider}.json (deployed with the site), and
 *     upserts into Supabase too if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 *
 *  3b. Optional: asks a free-tier AI (Groq or Gemini) for a short analyst-style take on the top-scored stocks.
 * Env: FMP_API_KEY, FINNHUB_API_KEY, ALPHA_VANTAGE_API_KEY, WATCHLIST (always deep-checked), EXTRA_TICKERS (added to the scan),
 *      DEEP_N (default 80), SCAN (set to "off" to skip the market scan),
 *      GROQ_API_KEY or GEMINI_API_KEY, AI_PROVIDER (groq|gemini), AI_MODEL, AI_MAX_STOCKS (default 15), AI_DELAY_MS,
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (optional), OUT_DIR (default public/data)
 * Node 18+ (global fetch). No npm dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { mockData } from "../src/mockData.js";
import { createProviders, createCache } from "../src/lib/providers.js";
import { buildLiveUniverse, buildLiveAnalystFeed, buildLiveInsider, refreshFromChart, buildNewsFlags } from "../src/lib/liveData.js";
import { percentileRanks } from "../src/lib/factors.js";
import { shortFacts, detectSetups } from "../src/lib/shortterm.js";
import { scoreUniverse, LIMITS } from "../src/scoring.js";
import { stockToRow, rowToStock, actionToRow, insiderToRow, rowToAction, rowToInsider } from "../src/lib/schema.js";
import { analyzeMany, buildPrompt, PROMPT_VERSION } from "../src/lib/ai.js";
import { nextHist, stockUpdate } from "../src/lib/updates.js";
import { loadUniverse, HOLDINGS } from "../src/lib/universe.js";
import { scanRow, pickDeepSet } from "../src/lib/scan.js";
import { mapLimit } from "../src/lib/providers.js";

const env = process.env;
const keys = { fmpKey: env.FMP_API_KEY || "", finnhubKey: env.FINNHUB_API_KEY || "", alphaVantageKey: env.ALPHA_VANTAGE_API_KEY || "" };
const OUT_DIR = env.OUT_DIR || "public/data";

if (!keys.fmpKey && !keys.finnhubKey && !keys.alphaVantageKey) {
  console.log("No API keys set (FMP_API_KEY / FINNHUB_API_KEY / ALPHA_VANTAGE_API_KEY). Skipping update; the site will use its fallback data.");
  process.exit(0);
}

const list = (v) => String(v || "").split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
const watchlist = list(env.WATCHLIST);
const baseByTicker = Object.fromEntries(mockData.stocks.map((s) => [s.ticker, s]));
// Small, slow-changing API results persist in cache/api-cache.json (committed by the workflow), so a second run
// the same day costs almost no quota and Alpha Vantage's 25 calls/day refresh each ticker about every 3 days.
// Big payloads (candles, news, insider lists) stay in memory only, to keep the repo small.
const CACHE_FILE = "cache/api-cache.json";
const PERSIST = /^(fmp:(p|dcf|pt|gc|r):|fh:rec:|av:o:|nq:f\d*:)/;
let store = {};
try { store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) {}
try { Object.assign(store, JSON.parse(fs.readFileSync("cache/alpha-vantage.json", "utf8"))); } catch (e) {} // older file name
const mem = createCache();
const fileCache = {
  get: (k) => {
    if (!PERSIST.test(k)) return mem.get(k);
    const r = store[k]; return r && Date.now() - r.t < r.ttl ? r.v : undefined;
  },
  set: (k, v, ttl) => (PERSIST.test(k) ? (store[k] = { t: Date.now(), ttl, v }) : mem.set(k, v, ttl)),
  clear: () => { store = {}; mem.clear(); },
};
const P = createProviders(keys, {
  cache: fileCache, avCache: fileCache, quoteTtlMin: 5, fundamentalsTtlHours: 20,
  avMaxCalls: Number(env.AV_MAX_CALLS || 22), avMinGapMs: Number(env.AV_MIN_GAP_MS || 13000),
  yahoo: env.SCAN !== "off", yahooGapMs: Number(env.YAHOO_GAP_MS || 220),
  nasdaq: env.NASDAQ !== "off", nasdaqGapMs: Number(env.NASDAQ_GAP_MS || 220),
});

const today = new Date().toISOString().slice(0, 10);
/* ---- Short-term context (setups, facts, earnings) — built right after the scan, used for priority + short.json ---- */
let shortCtx = null;
async function buildShortContext() {
  let earnings = {}, recentEarnings = {};
  if (P.finnhub && P.finnhub.earningsCalendar) {
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    earnings = await P.finnhub.earningsCalendar(today, day(70)).catch((e) => (console.warn("earnings calendar:", e.message), {}));
    recentEarnings = await P.finnhub.earningsCalendar(day(-4), day(-1)).catch(() => ({}));
    Object.entries(earnings).forEach(([t, d]) => { if (d <= today) recentEarnings[t] = d; }); // reporting today
  }
  const rank6All = percentileRanks(scanRows, "mom6");
  const facts = {};
  for (const r of scanRows) if (!r.fund && pre[r.ticker]) facts[r.ticker] = shortFacts(pre[r.ticker].candles);
  // Top 1-month gainers among heavily traded stocks ($5M+/day) above their 50-day: the weekly momentum list.
  const momTop = new Set(scanRows.filter((r) => facts[r.ticker] && facts[r.ticker].dollarVol >= 5e6 && r.price >= 5 && facts[r.ticker].sma50 && r.price > facts[r.ticker].sma50 && facts[r.ticker].ret21 != null)
    .sort((a, b) => facts[b.ticker].ret21 - facts[a.ticker].ret21).slice(0, 20).map((r) => r.ticker));
  const items = [];
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k] == null ? null : typeof o[k] === "number" ? Math.round(o[k] * 1000) / 1000 : o[k]]));
  for (const r of scanRows) {
    const f = facts[r.ticker];
    if (!f || !(f.dollarVol >= 2e6) || r.price < 3) continue; // tradable: $2M+ a day
    const setups = detectSetups(f, r.price, { rank6: rank6All[r.ticker] ?? null, momTop: momTop.has(r.ticker) });
    if (!setups.length) continue;
    items.push({ ticker: r.ticker, name: r.name, sector: r.sector, small: !!r.small, price: r.price, setups, rank6: rank6All[r.ticker] ?? null,
      ret5: r.ret5, ret20: r.ret20, vol63: r.vol63, earningsDate: earnings[r.ticker] || null,
      facts: pick(f, ["atr", "rsi2", "sma5", "sma50", "sma200", "gapToday", "volX", "ret21", "dollarVol", "gapSig"]) });
  }
  return { earnings, recentEarnings, facts, items };
}

/* ------------------------------- 0. Market scan ------------------------------- */
let tickers = watchlist.length ? watchlist : mockData.stocks.map((s) => s.ticker);
const pre = {};
/* ---- The pool: every stock fully checked in the last week (kept between runs by the Actions cache) ---- */
const POOL_FILE = "cache/pool.json";
let pool = { stocks: [], analyst: [], insider: [] };
try { pool = { ...pool, ...JSON.parse(fs.readFileSync(POOL_FILE, "utf8")) }; } catch (e) {
  try { pool.stocks = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "screener.json"), "utf8")).stocks || []; } catch (e2) {}
}
const lastChecked = Object.fromEntries(pool.stocks.filter((r) => r.checked_at).map((r) => [r.ticker, r.checked_at]));
console.log(`Pool: ${pool.stocks.length} stocks from earlier runs`);

let scanRows = [];
let universe = [];
let ranks = { mom12: {}, mom6: {} };
let spyMom3 = null;
if (P.yahoo) {
  universe = await loadUniverse({ extra: [...watchlist, ...list(env.EXTRA_TICKERS)], fallback: mockData.stocks, broad: env.BROAD !== "off", smallCaps: env.SMALL_CAPS === "on" }); // small caps lost money in the short-term backtest: off unless asked
  universe.forEach((u) => { if (!baseByTicker[u.ticker]) baseByTicker[u.ticker] = { name: u.name, sector: u.sector }; });
  console.log(`Market scan: ${universe.length} stocks…`);
  let done = 0, failedScan = 0;
  const rows = await mapLimit(universe, 3, async (u) => {
    try {
      const d = await P.yahoo.daily(u.ticker);
      pre[u.ticker] = d;
      return scanRow(u, d);
    } catch (e) { failedScan++; return null; }
    finally { if (++done % 50 === 0 || done === universe.length) process.stdout.write(`\r  ${done}/${universe.length}`); }
  });
  process.stdout.write("\n");
  scanRows = rows.filter((r) => r && r.ticker);
  console.log(`Scanned ${scanRows.length} (${failedScan} failed). Live FVG entries: ${scanRows.filter((r) => r.entryLive).length}, any bullish FVG: ${scanRows.filter((r) => r.fvgStatus !== "None").length}`);
  // Momentum is judged relative to the market: rank every $2B+ stock's 12-1 and 6-month return (small caps are short-term only).
  const bigRows = scanRows.filter((r) => !r.small);
  ranks = { mom12: percentileRanks(bigRows, "mom12_1"), mom6: percentileRanks(bigRows, "mom6") };
  const spy = scanRows.find((r) => r.ticker === "SPY");
  spyMom3 = spy ? spy.mom3 : null;
  scanRows.forEach((r) => {
    r.momRank12 = ranks.mom12[r.ticker] ?? null; r.momRank6 = ranks.mom6[r.ticker] ?? null;
    r.rs3 = r.mom3 != null && spyMom3 != null ? Math.round((r.mom3 - spyMom3) * 1000) / 1000 : null;
  });
  if (scanRows.length >= 20) {
    shortCtx = await buildShortContext();
    // Tonight's priority: everything the site shows (long-term picks, today's short-term trades) plus anything where
    // something significant just happened (big 1-day move or volume spike, earnings in the last few days).
    // These get the full check every night; the normal 400-stock rotation still runs on top, so it never slows down.
    const bigOk = (r) => r.price >= 5 && !r.fund && !r.small;
    const longPage = pool.stocks.filter((r) => (r.composite_score ?? 0) >= LIMITS.RECOMMEND).map((r) => r.ticker);
    const shortPage = shortCtx.items.filter((x) => !x.small).map((x) => x.ticker);
    const dayMove = (t) => { const c = pre[t] && pre[t].candles; return c && c.length > 2 ? c[c.length - 1].close / c[c.length - 2].close - 1 : null; };
    const bigMoves = scanRows.filter((r) => bigOk(r) && dayMove(r.ticker) != null && shortCtx.facts[r.ticker]
        && (Math.abs(dayMove(r.ticker)) >= 0.05 || ((shortCtx.facts[r.ticker].volX || 0) >= 3 && Math.abs(dayMove(r.ticker)) >= 0.025)))
      .sort((x, y) => Math.abs(dayMove(y.ticker)) - Math.abs(dayMove(x.ticker))).slice(0, 80).map((r) => r.ticker);
    const justReported = scanRows.filter((r) => bigOk(r) && shortCtx.recentEarnings[r.ticker])
      .sort((x, y) => ((shortCtx.facts[y.ticker] || {}).dollarVol || 0) - ((shortCtx.facts[x.ticker] || {}).dollarVol || 0)).slice(0, 80).map((r) => r.ticker);
    const priority = [...new Set([...longPage, ...shortPage, ...bigMoves, ...justReported])];
    console.log(`Priority tonight: ${priority.length} (long-term page ${longPage.length}, short-term ${shortPage.length}, big moves ${bigMoves.length}, just reported ${justReported.length})`);
    const deepN = Math.min(Number(env.DEEP_MAX || 650), Number(env.DEEP_N || 400) + priority.length);
    tickers = pickDeepSet(scanRows, { deepN, always: [...HOLDINGS, ...watchlist, ...priority], ranks, lastChecked });
    console.log("Deep check:", tickers.length, "stocks:", tickers.join(", "));
  } else {
    console.warn("Market scan returned too little data; deep-checking the watchlist / default list instead.");
  }
}

/* ------------------------------- 1. Deep check ------------------------------- */
console.log(`Updating ${tickers.length} tickers with: ${Object.entries(keys).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
const { stocks, failed } = await buildLiveUniverse(tickers, P, baseByTicker, (d, t) => process.stdout.write(`\r  ${d}/${t}`), pre);
process.stdout.write("\n");
if (failed.length) console.warn("No data for:", failed.join("; "));
if (!stocks.length) { console.error("No stocks returned — check API keys / plan limits."); process.exit(1); }
{
  const now = Date.now();
  for (const k of Object.keys(store)) if (now - store[k].t > store[k].ttl) delete store[k];
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
  try { fs.unlinkSync("cache/alpha-vantage.json"); } catch (e) {}
  console.log(`API cache: ${Object.keys(store).length} entries saved to ${CACHE_FILE}`);
  if (P.alpha) console.log(`Alpha Vantage: ${P.alpha.stats.used} live call(s) this run${P.alpha.stats.exhausted ? " (stopped: limit reply)" : ""}, ${Object.keys(store).filter((k) => k.startsWith("av:")).length} cached`);
}

/* ---------------- Last known good: don't let a failed call wipe yesterday's value ---------------- */
const CARRY = ["dcfValue", "peg", "fwdPE", "target12m", "buyPct", "analystCount"];
const MAX_CARRY_DAYS = 7;
const prevRows = Object.fromEntries(pool.stocks.map((r) => [r.ticker, r]));
let carried = 0;
for (const s of stocks) {
  const r = prevRows[s.ticker];
  if (!r) continue;
  const prev = rowToStock(r);
  const prevStale = r.stale_fields || {};
  s.staleFields = {};
  for (const f of CARRY) {
    if (s[f] != null || prev[f] == null || (f === "dcfValue" && (s.dcfNm || s.dcfNa))) continue;
    const since = prevStale[f] || String(r.updated_at || today).slice(0, 10);
    if ((Date.parse(today) - Date.parse(since)) / 864e5 > MAX_CARRY_DAYS) continue;
    s[f] = prev[f]; s.staleFields[f] = since; carried++;
  }
}
if (carried) console.log(`Kept ${carried} last-known-good value(s) where today's call failed (max ${MAX_CARRY_DAYS} days)`);

/* ------------- Keep stocks fully checked in the last few days (fundamentals change slowly) ------------- */
const KEEP_DAYS = Number(env.KEEP_DAYS || 7);
const fresh = new Set(stocks.map((s) => s.ticker));
const carriedTickers = [];
for (const [t, r] of Object.entries(prevRows)) {
  if (fresh.has(t) || !pre[t]) continue;
  const checked = r.checked_at; // only rows from the current model (they carry the factor data)
  if (!checked || !r.factors || !("revUp" in r.factors) || (Date.parse(today) - Date.parse(checked)) / 864e5 > KEEP_DAYS) continue;
  const prev = rowToStock(r);
  if (!prev.checkedAt) prev.checkedAt = checked;
  const s = refreshFromChart(prev, pre[t].candles, pre[t].price);
  if (s) { stocks.push(s); carriedTickers.push(t); }
}
if (carriedTickers.length) console.log(`Kept ${carriedTickers.length} stocks checked in the last ${KEEP_DAYS} days (price + chart refreshed today)`);

// Market-relative momentum on every stock.
for (const s of stocks) {
  s.factors = s.factors || {};
  s.factors.momRank12 = ranks.mom12[s.ticker] ?? null;
  s.factors.momRank6 = ranks.mom6[s.ticker] ?? null;
  s.factors.rs3 = s.factors.mom3 != null && spyMom3 != null ? Math.round((s.factors.mom3 - spyMom3) * 1000) / 1000 : null;
}

const names = Object.fromEntries(stocks.map((s) => [s.ticker, s.name]));
const freshTickers = stocks.filter((s) => !s.carried).map((s) => s.ticker);
let analyst = await buildLiveAnalystFeed(freshTickers, P, { names }).catch((e) => (console.warn("analyst feed:", e.message), []));
let insider = await buildLiveInsider(freshTickers, P).catch((e) => (console.warn("insider:", e.message), []));
// Carried stocks keep their recent analyst actions and insider trades from the last run.
{
  const keep = new Set(carriedTickers);
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const readOld = (f, k) => { if (pool[k] && pool[k].length) return pool[k]; try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")).items || []; } catch (e) { return []; } };
  analyst = analyst.concat(readOld("analyst.json", "analyst").map(rowToAction).filter((a) => keep.has(a.ticker) && a.date >= since30));
  insider = insider.concat(readOld("insider.json", "insider").map(rowToInsider).filter((x) => keep.has(x.ticker)));
}
// Bad-news headlines for your holdings and today's checks (same cached Finnhub news as the analyst feed).
const newsFlags = await buildNewsFlags(freshTickers, P, { names }).catch((e) => (console.warn("news flags:", e.message), {}));
stocks.forEach((s) => { if (newsFlags[s.ticker]) s.newsFlags = newsFlags[s.ticker]; else if (!s.carried) s.newsFlags = []; });
console.log(`News flags: ${Object.keys(newsFlags).length} stocks with negative headlines this week`);

const scored = scoreUniverse(stocks, mockData.sectorPE, insider);

/* ------------------------------- AI analyst take ------------------------------- */
const maxStocks = Number(env.AI_MAX_STOCKS || 15);
const targets = scored.slice().sort((a, b) => b.composite - a.composite).slice(0, maxStocks);
const byTicker = {};
analyst.forEach((a) => (byTicker[a.ticker] = byTicker[a.ticker] || []).push(a));
// Keep earlier takes for stocks that don't get a fresh one this run.
// (Takes written under older instructions are dropped so they get rewritten; see PROMPT_VERSION.)
const previous = Object.fromEntries(pool.stocks.filter((r) => r.ai_take && (r.ai_take.pv || 0) >= PROMPT_VERSION).map((r) => [r.ticker, r.ai_take]));
scored.forEach((s) => { if (previous[s.ticker]) s.ai = { ...previous[s.ticker], stale: true }; });

// Brief for the Claude step in the workflow (reads .ai/brief.md, writes .ai/claude_takes.json, merged by merge-ai-takes.mjs).
fs.mkdirSync(".ai", { recursive: true });
fs.writeFileSync(".ai/brief.md", targets.map((s) => "## " + s.ticker + "\n" + buildPrompt(s, { headlines: byTicker[s.ticker] || [] })).join("\n\n") + "\n");
console.log(`Wrote .ai/brief.md for ${targets.length} stocks`);

const aiKey = env.GROQ_API_KEY || env.GEMINI_API_KEY;
if (aiKey) {
  const provider = env.AI_PROVIDER || (env.GROQ_API_KEY ? "groq" : "gemini");
  console.log(`AI (${provider}): analyzing ${targets.length} stocks…`);
  const { takes, errors } = await analyzeMany(targets, (s) => ({ headlines: byTicker[s.ticker] || [] }), {
    provider, apiKey: provider === "groq" ? env.GROQ_API_KEY : env.GEMINI_API_KEY, model: env.AI_MODEL || undefined,
    delayMs: Number(env.AI_DELAY_MS || (provider === "groq" ? 8000 : 5000)),
  }, (d, t) => process.stdout.write(`\r  ${d}/${t}`));
  process.stdout.write("\n");
  if (errors.length) console.warn(`AI failed for ${errors.length}:`, errors.slice(0, 3).join(" | "));
  scored.forEach((s) => { if (takes[s.ticker]) s.ai = takes[s.ticker]; });
  console.log(`AI takes: ${Object.keys(takes).length} new, ${scored.filter((s) => s.ai && s.ai.stale).length} carried over`);
} else {
  console.log("No GROQ_API_KEY / GEMINI_API_KEY: skipping the free-tier AI step (Claude step or rule-based summaries cover it).");
}

// Daily "Update:" — what changed since the last trading day (the site adds what to do about it).
{
  const recent = shortCtx ? shortCtx.recentEarnings : {};
  scored.forEach((s) => {
    const prev = prevRows[s.ticker];
    s.hist = nextHist(prev && prev.hist, s, today);
    const c = pre[s.ticker] && pre[s.ticker].candles;
    const dayMove = c && c.length > 2 ? c[c.length - 1].close / c[c.length - 2].close - 1 : null;
    const ps = prev && prev.factors && Array.isArray(prev.factors.surprises) ? prev.factors.surprises[0] : null;
    s.upd = stockUpdate(s, s.hist, { today, dayMove, reportedOn: recent[s.ticker] || null, prevSurprise: ps });
  });
  const n = scored.filter((s) => s.upd.events.length).length;
  console.log(`Updates: ${n} stocks with something new today (${scored.filter((s) => s.upd.tone === "bad").length} bad, ${scored.filter((s) => s.upd.tone === "good").length} good)`);
}
const rows = scored.map(stockToRow);
const generatedAt = new Date().toISOString();

// Full pool for the next run (Actions cache, not committed).
fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
fs.writeFileSync(POOL_FILE, JSON.stringify({ generatedAt, stocks: rows, analyst: analyst.map(actionToRow), insider: insider.map(insiderToRow) }));

// What the site loads: stocks scoring 50+ plus your holdings / watchlist, and only their analyst + insider items.
const MIN_PUBLIC = Number(env.MIN_PUBLIC_SCORE || 50);
const keepT = new Set([...HOLDINGS, ...watchlist]);
const pubRows = rows.filter((r) => (r.composite_score ?? 0) >= MIN_PUBLIC || keepT.has(r.ticker)).map(({ hist, ...r }) => r); // history stays in the pool
const pubT = new Set(pubRows.map((r) => r.ticker));
const capPer = (items, n) => { const c = {}; return items.filter((x) => (c[x.ticker] = (c[x.ticker] || 0) + 1) <= n); };
const pubAnalyst = capPer(analyst.filter((a) => pubT.has(a.ticker)).sort((a, b) => (b.date || "").localeCompare(a.date || "")), 5);
const pubInsider = capPer(insider.filter((x) => pubT.has(x.ticker) && (x.value > 0 || Math.abs(x.value) >= 50000)).sort((a, b) => (b.date || "").localeCompare(a.date || "")), 12);

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (f, obj) => fs.writeFileSync(path.join(OUT_DIR, f), JSON.stringify(obj));
write("screener.json", { generatedAt, spyMom3, poolSize: rows.length, stocks: pubRows });
if (scanRows.length) {
  const deepSet = new Set(stocks.map((s) => s.ticker));
  // Score + rank (1 = best) for every fully checked stock, so the site's search can show where any stock stands.
  const ranked = rows.filter((r) => r.composite_score != null).sort((a, b) => b.composite_score - a.composite_score);
  const scoreOf = new Map(ranked.map((r, j) => [r.ticker, [r.composite_score, j + 1]]));
  // Small caps only appear on the Short-term page (short.json), unless you hold them.
  write("scan.json", { generatedAt, universeSize: universe.filter((u) => !u.small).length, scanned: scanRows.filter((r) => !r.small).length, fullyChecked: rows.length,
    rankedCount: ranked.length,
    items: scanRows.filter((r) => !r.small || keepT.has(r.ticker)).map((r) => { const sr = scoreOf.get(r.ticker); return { ...r, deep: deepSet.has(r.ticker), sc: sr ? sr[0] : null, rk: sr ? sr[1] : null }; }) });

  /* ---------------- Short-term setups (days to weeks), incl. small caps ---------------- */
  if (!shortCtx) shortCtx = await buildShortContext();
  const { earnings, items: shortItems } = shortCtx;
  const holdEarn = Object.fromEntries([...keepT].filter((t) => earnings[t]).map((t) => [t, earnings[t]]));
  write("short.json", { generatedAt, scanned: scanRows.length, smallCaps: scanRows.filter((r) => r.small).length, earnings: holdEarn, items: shortItems });
  const cnt = {}; shortItems.forEach((x) => x.setups.forEach((k) => (cnt[k] = (cnt[k] || 0) + 1)));
  console.log(`Short-term: ${shortItems.length} setups today (${Object.entries(cnt).map(([k, v]) => v + " " + k).join(", ")}); earnings dates for ${Object.keys(earnings).length} companies`);
}
if (pubAnalyst.length) write("analyst.json", { generatedAt, items: pubAnalyst.map(actionToRow) });
if (pubInsider.length) write("insider.json", { generatedAt, items: pubInsider.map(insiderToRow) });
console.log(`Pool: ${rows.length} fully checked (${stocks.filter((s) => !s.carried).length} today, ${carriedTickers.length} from the last ${KEEP_DAYS} days). Site gets ${pubRows.length} (score ${MIN_PUBLIC}+ and holdings), ${pubAnalyst.length} analyst actions, ${pubInsider.length} insider trades.`);

// Group failures by endpoint + reply so the log shows exactly what each provider said.
const groups = {};
for (const s of stocks) for (const n of s.dataNotes || []) {
  const [label, ...rest] = n.split(": ");
  const key = label + ": " + rest.join(": ").slice(0, 160);
  (groups[key] = groups[key] || []).push(s.ticker);
}
const keysSorted = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
if (keysSorted.length) {
  console.log(`Unavailable fields (${keysSorted.reduce((a, k) => a + groups[k].length, 0)} total):`);
  for (const k of keysSorted) console.log(`  [${groups[k].length}] ${k}  (${groups[k].slice(0, 6).join(", ")}${groups[k].length > 6 ? ", …" : ""})`);
}

/* ------------------------------- Supabase upsert ------------------------------- */
async function upsert(table, data, onConflict) {
  if (!data.length) return;
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
  console.log(`Supabase: upserted ${data.length} rows into ${table}`);
}

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    await upsert("screener_metrics", rows, "ticker");
    await upsert("analyst_actions", analyst.map(actionToRow), "ticker,firm,action_date,to_rating");
    await upsert("insider_transactions", insider.map(insiderToRow), "ticker,filing_date,insider_role,value");
  } catch (e) {
    console.error("Supabase upsert failed:", e.message);
    process.exitCode = 1;
  }
}
