#!/usr/bin/env node
/**
 * merge-ai-takes.mjs — merges the Claude step's output (.ai/claude_takes.json) into public/data/screener.json
 * (and Supabase, if configured). Invalid or missing takes are skipped, so earlier/free-tier takes stay in place.
 */
import fs from "node:fs";
import path from "node:path";
import { parseAiJson } from "../src/lib/ai.js";

const env = process.env;
const OUT_DIR = env.OUT_DIR || "public/data";
const file = path.join(OUT_DIR, "screener.json");
let takes;
try { takes = JSON.parse(fs.readFileSync(".ai/claude_takes.json", "utf8")); }
catch (e) { console.log("No valid .ai/claude_takes.json; keeping existing takes."); process.exit(0); }

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const now = new Date().toISOString();
let merged = 0;
for (const row of data.stocks) {
  const raw = takes[row.ticker];
  const t = raw && parseAiJson(JSON.stringify(raw));
  if (!t) continue;
  row.ai_take = { ...t, model: "Claude (Pro plan)", source: "ai", generatedAt: now };
  merged++;
}
fs.writeFileSync(file, JSON.stringify(data));
console.log(`Merged ${merged} Claude takes into ${file}`);
// Keep them in the full pool too, so they carry over to the next runs.
try {
  const POOL = "cache/pool.json";
  const pool = JSON.parse(fs.readFileSync(POOL, "utf8"));
  const fresh = Object.fromEntries(data.stocks.filter((r) => r.ai_take && r.ai_take.generatedAt === now).map((r) => [r.ticker, r.ai_take]));
  pool.stocks.forEach((r) => { if (fresh[r.ticker]) r.ai_take = fresh[r.ticker]; });
  fs.writeFileSync(POOL, JSON.stringify(pool));
} catch (e) {}

if (merged && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const rows = data.stocks.filter((r) => r.ai_take && r.ai_take.generatedAt === now).map((r) => ({ ticker: r.ticker, ai_take: r.ai_take }));
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/screener_metrics?on_conflict=ticker`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  console.log(res.ok ? `Supabase: updated ${rows.length} AI takes` : `Supabase update failed: HTTP ${res.status}`);
}
