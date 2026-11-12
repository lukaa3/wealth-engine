#!/usr/bin/env node
/**
 * check-stock.mjs — run any ticker(s) through the site's full check and score, and print the result.
 * Used by the manual "Check a stock" workflow:  TICKERS="MU,AMD" node scripts/check-stock.mjs
 * Momentum ranks come from today's market scan (public/data/scan.json), so scores match the site.
 */
import fs from "node:fs";
import { createProviders } from "../src/lib/providers.js";
import { buildLiveStock, buildLiveInsider, buildNewsFlags } from "../src/lib/liveData.js";
import { scoreStock, insiderNetByTicker, suggestedSize } from "../src/scoring.js";
import { SECTOR_PE } from "../src/mockData.js";
import { ruleSummary } from "../src/lib/ai.js";

const env = process.env;
const tickers = String(env.TICKERS || "").toUpperCase().split(/[\s,]+/).filter(Boolean);
if (!tickers.length) { console.error("Set TICKERS"); process.exit(1); }
const P = createProviders(
  { fmpKey: env.FMP_API_KEY, finnhubKey: env.FINNHUB_API_KEY, alphaVantageKey: env.ALPHA_VANTAGE_API_KEY },
  { yahoo: true, nasdaq: true, avMaxCalls: 3 },
);
let scan = { items: [] };
try { scan = JSON.parse(fs.readFileSync("public/data/scan.json", "utf8")); } catch (e) {}
const byScan = Object.fromEntries((scan.items || []).map((r) => [r.ticker, r]));
const p1 = (x) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");

for (const t of tickers) {
  const sr = byScan[t] || {};
  const y = await P.yahoo.daily(t).catch((e) => (console.log(t, "chart failed:", e.message), null));
  const s = await buildLiveStock(t, P, { name: sr.name || t, sector: sr.sector || "Other" }, y ? { candles: y.candles, price: y.price, name: y.name } : null);
  if (!s) { console.log(t, ": no data"); continue; }
  s.factors = { ...(s.factors || {}), momRank12: sr.momRank12 ?? null, momRank6: sr.momRank6 ?? null, rs3: sr.rs3 ?? null };
  const ins = await buildLiveInsider([t], P).catch(() => []);
  const flags = await buildNewsFlags([t], P, { names: { [t]: s.name } }).catch(() => ({}));
  s.newsFlags = flags[t] || [];
  const sc = scoreStock(s, SECTOR_PE, insiderNetByTicker(ins)[t]);
  const rs = ruleSummary(sc);
  console.log(`\n================ ${t} · ${sc.name} · ${sc.sector} · $${sc.price} ================`);
  console.log(`SCORE ${sc.composite}/100  →  momentum ${sc.momentum}/34 · earnings ${sc.earnings}/25 · quality ${sc.quality}/15 · value ${sc.value}/15 · smart ${sc.smart}/11`);
  console.log(`Horizon: ${sc.horizon} (fits ${JSON.stringify(sc.fits)}) · Risk: ${sc.risk} · Partial: ${sc.partial.join(", ") || "none"}`);
  for (const [k, rows] of Object.entries(sc.breakdown)) {
    console.log(`  [${k}]`);
    rows.forEach((r) => console.log(`    ${r.label.padEnd(24)} ${String(r.value).padEnd(44)} ${r.pts}/${r.max}`));
  }
  const bp = sc.buyPlan;
  console.log("Buy plan: all now ~$" + bp.steps[0].price.toFixed(2) + " (" + bp.steps[0].why + "), rethink below $" + bp.stop);
  console.log("Stop:", "$" + bp.stop, "(" + p1(bp.stopPct) + ")", "· Take profit:", bp.take.text, bp.note ? "· " + bp.note : "");
  console.log("Size:", Math.round(suggestedSize(sc, 0).pct * 100) + "% of portfolio");
  console.log("Verdict:", rs.verdict, "·", rs.summary);
  console.log("Bull:", rs.bull.join(" | "));
  console.log("Bear:", rs.bear.join(" | "));
  console.log("Targets: 12-mo street", sc.target12m, p1(sc.upside12m), "· analysts", sc.analystCount, "buy%", sc.buyPct);
  console.log("Headlines flagged:", s.newsFlags.map((n) => n.date + " " + n.headline).join(" | ") || "none");
}
