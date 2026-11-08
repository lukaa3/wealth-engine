#!/usr/bin/env node
/**
 * update-screener.mjs — background job (run by .github/workflows/deploy.yml on a schedule).
 *
 *  0. Market scan: daily charts for the whole universe (S&P 500 + Nasdaq-100 extras + popular names, ~550 stocks)
 *     from Yahoo's free chart feed → momentum + FVG setup for each → public/data/scan.json. The best setups and the
 *     strongest movers (DEEP_N, default 50) go on to step 1.
 *  1. Deep check: quotes, DCF, price targets, analyst consensus/grades, ratios for those stocks
 *     from FMP / Finnhub / Alpha Vantage (whichever keys are set).
 *  2. Detects bullish FVGs, Fib depth and support, and derives stops, 1-mo / 6-mo targets and DCA zones.
 *  3. Scores everything with the same scorer the UI uses.
 *  4. Writes public/data/{screener,analyst,insider}.json (deployed with the site), and
 *     upserts into Supabase too if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 *
 *  3b. Optional: asks a free-tier AI (Groq or Gemini) for a short analyst-style take on the top-scored stocks.
 * Env: FMP_API_KEY, FINNHUB_API_KEY, ALPHA_VANTAGE_API_KEY, WATCHLIST (always deep-checked), EXTRA_TICKERS (added to the scan),
 *      DEEP_N (default 50), SCAN (set to "off" to skip the market scan),
 *      GROQ_API_KEY or GEMINI_API_KEY, AI_PROVIDER (groq|gemini), AI_MODEL, AI_MAX_STOCKS (default 15), AI_DELAY_MS,
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (optional), OUT_DIR (default public/data)
 * Node 18+ (global fetch). No npm dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { mockData } from "../src/mockData.js";
import { createProviders, createCache } from "../src/lib/providers.js";
import { buildLiveUniverse, buildLiveAnalystFeed, buildLiveInsider } from "../src/lib/liveData.js";
import { scoreUniverse } from "../src/scoring.js";
import { stockToRow, rowToStock, actionToRow, insiderToRow } from "../src/lib/schema.js";
import { analyzeMany, buildPrompt } from "../src/lib/ai.js";
import { loadUniverse } from "../src/lib/universe.js";
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
const PERSIST = /^(fmp:(p|dcf|pt|gc|r):|fh:rec:|av:o:|nq:f:)/;
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
  yahoo: env.SCAN !== "off", yahooGapMs: Number(env.YAHOO_GAP_MS || 350),
  nasdaq: env.NASDAQ !== "off", nasdaqGapMs: Number(env.NASDAQ_GAP_MS || 250),
});

/* ------------------------------- 0. Market scan ------------------------------- */
let tickers = watchlist.length ? watchlist : mockData.stocks.map((s) => s.ticker);
const pre = {};
let scanRows = [];
let universe = [];
if (P.yahoo) {
  universe = await loadUniverse({ extra: [...watchlist, ...list(env.EXTRA_TICKERS)], fallback: mockData.stocks });
  universe.forEach((u) => { if (!baseByTicker[u.ticker]) baseByTicker[u.ticker] = { name: u.name, sector: u.sector }; });
  console.log(`Market scan: ${universe.length} stocks…`);
  let done = 0, failedScan = 0;
  const rows = await mapLimit(universe, 2, async (u) => {
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
  if (scanRows.length >= 20) {
    tickers = pickDeepSet(scanRows, { deepN: Number(env.DEEP_N || 50), watchlist });
    console.log("Deep check:", tickers.join(", "));
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
let prevRows = {};
try {
  const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "screener.json"), "utf8"));
  prevRows = Object.fromEntries((old.stocks || []).map((r) => [r.ticker, r]));
} catch (e) {}
let carried = 0;
const today = new Date().toISOString().slice(0, 10);
for (const s of stocks) {
  const r = prevRows[s.ticker];
  if (!r) continue;
  const prev = rowToStock(r);
  const prevStale = r.stale_fields || {};
  s.staleFields = {};
  for (const f of CARRY) {
    if (s[f] != null || prev[f] == null || (f === "dcfValue" && s.dcfNm)) continue;
    const since = prevStale[f] || String(r.updated_at || today).slice(0, 10);
    if ((Date.parse(today) - Date.parse(since)) / 864e5 > MAX_CARRY_DAYS) continue;
    s[f] = prev[f]; s.staleFields[f] = since; carried++;
  }
}
if (carried) console.log(`Kept ${carried} last-known-good value(s) where today's call failed (max ${MAX_CARRY_DAYS} days)`);

const names = Object.fromEntries(stocks.map((s) => [s.ticker, s.name]));
const analyst = await buildLiveAnalystFeed(tickers, P, { names }).catch((e) => (console.warn("analyst feed:", e.message), []));
const insider = await buildLiveInsider(tickers, P).catch((e) => (console.warn("insider:", e.message), []));

const scored = scoreUniverse(stocks, mockData.sectorPE, insider);

/* ------------------------------- AI analyst take ------------------------------- */
const maxStocks = Number(env.AI_MAX_STOCKS || 15);
const targets = scored.slice().sort((a, b) => b.composite - a.composite).slice(0, maxStocks);
const byTicker = {};
analyst.forEach((a) => (byTicker[a.ticker] = byTicker[a.ticker] || []).push(a));
// Keep earlier takes for stocks that don't get a fresh one this run.
let previous = {};
try {
  const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "screener.json"), "utf8"));
  previous = Object.fromEntries((old.stocks || []).filter((r) => r.ai_take).map((r) => [r.ticker, r.ai_take]));
} catch (e) {}
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

const rows = scored.map(stockToRow);
const generatedAt = new Date().toISOString();

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (f, obj) => fs.writeFileSync(path.join(OUT_DIR, f), JSON.stringify(obj, null, 1));
write("screener.json", { generatedAt, stocks: rows });
if (scanRows.length) {
  const deepSet = new Set(stocks.map((s) => s.ticker));
  write("scan.json", { generatedAt, universeSize: universe.length, scanned: scanRows.length,
    items: scanRows.map((r) => ({ ...r, deep: deepSet.has(r.ticker) })) });
}
if (analyst.length) write("analyst.json", { generatedAt, items: analyst.map(actionToRow) });
if (insider.length) write("insider.json", { generatedAt, items: insider.map(insiderToRow) });
console.log(`Wrote ${rows.length} stocks, ${analyst.length} analyst actions, ${insider.length} insider trades to ${OUT_DIR}/`);

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
