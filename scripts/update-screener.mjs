#!/usr/bin/env node
/**
 * update-screener.mjs — background job (run by .github/workflows/deploy.yml on a schedule).
 *
 *  1. Pulls quotes, DCF, price targets, analyst consensus/grades, ratios and daily candles for the watchlist
 *     from FMP / Finnhub / Alpha Vantage (whichever keys are set).
 *  2. Detects bullish FVGs, Fib depth and support, and derives stops, 1-mo / 6-mo targets and DCA zones.
 *  3. Scores everything with the same scorer the UI uses.
 *  4. Writes public/data/{screener,analyst,insider}.json (deployed with the site), and
 *     upserts into Supabase too if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 *
 *  3b. Optional: asks a free-tier AI (Groq or Gemini) for a short analyst-style take on the top-scored stocks.
 * Env: FMP_API_KEY, FINNHUB_API_KEY, ALPHA_VANTAGE_API_KEY, WATCHLIST (comma list, optional),
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
import { stockToRow, actionToRow, insiderToRow } from "../src/lib/schema.js";
import { analyzeMany, buildPrompt } from "../src/lib/ai.js";

const env = process.env;
const keys = { fmpKey: env.FMP_API_KEY || "", finnhubKey: env.FINNHUB_API_KEY || "", alphaVantageKey: env.ALPHA_VANTAGE_API_KEY || "" };
const OUT_DIR = env.OUT_DIR || "public/data";

if (!keys.fmpKey && !keys.finnhubKey && !keys.alphaVantageKey) {
  console.log("No API keys set (FMP_API_KEY / FINNHUB_API_KEY / ALPHA_VANTAGE_API_KEY). Skipping update; the site will use its fallback data.");
  process.exit(0);
}

const tickers = (env.WATCHLIST || mockData.stocks.map((s) => s.ticker).join(","))
  .split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
const baseByTicker = Object.fromEntries(mockData.stocks.map((s) => [s.ticker, s]));
const P = createProviders(keys, { cache: createCache(), quoteTtlMin: 5, fundamentalsTtlHours: 24 });

console.log(`Updating ${tickers.length} tickers with: ${Object.entries(keys).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
const { stocks, failed } = await buildLiveUniverse(tickers, P, baseByTicker, (d, t) => process.stdout.write(`\r  ${d}/${t}`));
process.stdout.write("\n");
if (failed.length) console.warn("No data for:", failed.join("; "));
if (!stocks.length) { console.error("No stocks returned — check API keys / plan limits."); process.exit(1); }

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
if (analyst.length) write("analyst.json", { generatedAt, items: analyst.map(actionToRow) });
if (insider.length) write("insider.json", { generatedAt, items: insider.map(insiderToRow) });
console.log(`Wrote ${rows.length} stocks, ${analyst.length} analyst actions, ${insider.length} insider trades to ${OUT_DIR}/`);

const notes = stocks.flatMap((s) => (s.dataNotes || []).map((n) => s.ticker + " " + n));
if (notes.length) console.log(`${notes.length} field(s) unavailable on this plan, e.g.:\n  ` + notes.slice(0, 6).join("\n  "));

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
