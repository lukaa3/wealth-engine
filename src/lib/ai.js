/**
 * ai.js — AI "analyst take" for each stock, plus a rule-based fallback.
 *
 * Runs in the GitHub Action (scripts/update-screener.mjs), so the AI key stays in GitHub secrets.
 * Uses any OpenAI-compatible chat endpoint. Free-tier presets:
 *   groq   — https://console.groq.com (free plan, rate-limited; default)
 *   gemini — Google AI Studio key (free tier on Flash / Flash-Lite models; free-tier prompts may be used by Google to improve products)
 * The model only sees the numbers and headlines we pass in and is told not to add outside facts.
 */

export const AI_PRESETS = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-flash-latest" },
};

const VERDICTS = ["Buy setup", "Accumulate", "Wait for entry", "Watch", "Avoid"];
const f2 = (x) => (x == null || !isFinite(x) ? "n/a" : Number(x).toFixed(2));
const p1 = (x) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compact, factual context for one scored stock. */
export function buildPrompt(s, { headlines = [] } = {}) {
  const f = s.factors || {};
  const bp = s.buyPlan;
  const lines = [
    `Ticker: ${s.ticker} (${s.name}), sector ${s.sector}. Price $${f2(s.price)}, beta ${f2(s.beta)}. Risk level ${s.risk}. Best-fit horizon: ${s.horizon}.`,
    `Composite score ${s.composite}/100 = momentum & trend ${s.momentum}/34, earnings momentum ${s.earnings}/25, quality ${s.quality}/15, valuation ${s.value}/15, smart money & setup ${s.smart}/11.`,
    `Momentum: 12-1 month ${p1(f.mom12_1)} (rank ${f.momRank12 != null ? Math.round(f.momRank12 * 100) + "th pct" : "n/a"}), 6-month ${p1(f.mom6)}, 3-month vs S&P ${p1(f.rs3)}. Above 200-day avg: ${f.above200 == null ? "n/a" : f.above200 ? "yes" : "no"}; ${p1(f.ext50)} vs 50-day; ${p1(f.fromHigh)} from 52-week high; 3-month volatility ${p1(f.vol63)} annualized.`,
    `Earnings: EPS estimate revisions last 4 weeks ${f.revUp ?? "n/a"} up / ${f.revDown ?? "n/a"} down; consensus change 1 month ${p1(f.consensusChange1m)}; expected EPS growth next year ${p1(f.epsGrowthNext)}; last quarters' surprises ${Array.isArray(f.surprises) ? f.surprises.map((x) => p1(x)).join(", ") : "n/a"}.`,
    `Quality: operating margin ${p1(f.opMargin)}, ROE ${p1(f.roe)}, FCF yield ${p1(f.fcfYield)}, net debt/market cap ${p1(f.netDebtToCap)}.`,
    `Valuation: PEG ${f2(s.peg)}, forward P/E ${f2(s.fwdPE)} vs sector ${s.sectorPE}, DCF $${f2(s.dcfValue)} (${p1(s.dcfUpside)} vs price, rough model).`,
    `Street & insiders: ${s.buyPct == null ? "no consensus" : Math.round(s.buyPct * 100) + "% Buy of " + s.analystCount} analysts, target $${f2(s.target12m)} (${p1(s.upside12m)}). Insider net 90d: $${Math.round(s.insider.net).toLocaleString("en-US")}.`,
    `Entry timing: ${s.fvg.status === "None" ? "no active bullish FVG" : `${s.fvg.tf} bullish FVG ${s.fvg.status.toLowerCase()} at $${f2(s.fvg.lo)}-$${f2(s.fvg.hi)}`}; plan status "${s.plan.status}". Buy plan: ${bp ? `buy the whole position now (~$${f2(bp.steps[0].price)}; backtest: all at once beat waiting for dips), rethink below $${f2(bp.stop)}` : "n/a"}.`,
  ];
  if ((s.newsFlags || []).length) lines.push("Negative headlines this week:\n" + s.newsFlags.map((n) => `- ${n.date} ${n.headline}`).join("\n"));
  if (headlines.length) lines.push("Recent analyst headlines:\n" + headlines.slice(0, 6).map((h) => `- ${h.date} ${h.firm}: ${h.headline || h.action + " " + (h.toRating || "")}${h.newTarget ? " (PT $" + h.newTarget + ")" : ""}`).join("\n"));
  return lines.join("\n");
}

const SYSTEM = `You are a disciplined equity analyst writing a short note for a young investor holding stocks from a few weeks to a few years.
Weigh momentum and earnings-estimate trends most, then quality and valuation; treat the FVG only as entry timing.
Use ONLY the data provided. Do not add news, numbers, products or events that are not in the data. If data is missing, say so.
Return a JSON object with exactly these keys:
 "verdict": one of ${VERDICTS.map((v) => `"${v}"`).join(", ")},
 "summary": 2 sentences on why the setup looks the way it does,
 "bull": array of 2 short bullet strings,
 "bear": array of 2 short bullet strings,
 "watch": one short sentence naming the level or event to watch next,
 "confidence": "low", "medium" or "high".
Plain language, no hype, no guarantees, no advice to buy or sell.`;

/** Pull the first JSON object out of a model reply. */
export function parseAiJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const arr = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 3) : []);
    const verdict = VERDICTS.find((v) => v.toLowerCase() === String(o.verdict || "").toLowerCase()) || "Watch";
    if (!o.summary) return null;
    return { verdict, summary: String(o.summary).slice(0, 400), bull: arr(o.bull), bear: arr(o.bear), watch: String(o.watch || "").slice(0, 200),
      confidence: ["low", "medium", "high"].includes(o.confidence) ? o.confidence : "medium" };
  } catch (e) { return null; }
}

/** One stock → AI take. opts: { provider, apiKey, model, url, fetchImpl } */
export async function aiAnalyze(s, ctx, opts) {
  const preset = AI_PRESETS[opts.provider] || AI_PRESETS.groq;
  const url = opts.url || preset.url;
  const model = opts.model || preset.model;
  const doFetch = opts.fetchImpl || fetch;
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: buildPrompt(s, ctx) }],
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get && res.headers.get("retry-after")) * 1000 || 15000 * (attempt + 1);
      await sleep(Math.min(wait, 60000));
      continue;
    }
    if (res.status === 400 && body.response_format) { delete body.response_format; continue; } // some models reject json mode
    if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const take = parseAiJson(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
    if (!take) throw new Error("AI reply was not valid JSON");
    return { ...take, model, source: "ai", generatedAt: new Date().toISOString() };
  }
  throw new Error("AI rate limit: gave up after retries");
}

/** Analyze several stocks one at a time, paced to stay inside free-tier per-minute limits. */
export async function analyzeMany(stocks, ctxFor, opts, onProgress) {
  const out = {};
  const errors = [];
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    try { out[s.ticker] = await aiAnalyze(s, ctxFor(s), opts); }
    catch (e) { errors.push(s.ticker + ": " + e.message); }
    if (onProgress) onProgress(i + 1, stocks.length);
    if (i < stocks.length - 1) await sleep(opts.delayMs ?? 8000);
  }
  return { takes: out, errors };
}

/** Deterministic summary from the numbers — shown when no AI take exists. */
export function ruleSummary(s) {
  const f = s.factors || {};
  const bull = [], bear = [];
  if (f.momRank12 != null && f.momRank12 >= 0.8) bull.push(`Momentum leader: stronger than ${Math.round(f.momRank12 * 100)}% of stocks over the past year`);
  if ((f.revUp || 0) > (f.revDown || 0) + 1) bull.push(`Analysts raising EPS estimates (${f.revUp} up vs ${f.revDown || 0} down)`);
  if (f.epsGrowthNext != null && f.epsGrowthNext >= 0.15) bull.push(`EPS expected to grow ${p1(f.epsGrowthNext)} next year`);
  if (f.opMargin != null && f.opMargin >= 0.2) bull.push(`High-quality business (${Math.round(f.opMargin * 100)}% operating margin)`);
  if (s.peg != null && s.peg > 0 && s.peg < 1) bull.push(`PEG ${f2(s.peg)}: growth priced cheaply`);
  if (s.insider.buys >= 1e6) bull.push("Insiders bought $1M+ in 90 days");
  if (s.plan.status === "live") bull.push(`${s.fvg.tf} FVG entry is live`);
  if (f.above200 === false) bear.push("Below its 200-day average (no long-term uptrend)");
  if ((f.revDown || 0) > (f.revUp || 0) + 1) bear.push(`Analysts cutting EPS estimates (${f.revDown} down)`);
  if (f.ext50 != null && f.ext50 > 0.15) bear.push(`Stretched ${p1(f.ext50)} above its 50-day average; wait for a pullback`);
  if (f.opMargin != null && f.opMargin < 0) bear.push("Not profitable yet");
  if (s.peg != null && s.peg > 2.5) bear.push(`Expensive for its growth (PEG ${f2(s.peg)})`);
  if ((s.newsFlags || []).length) bear.push("Negative headline this week: " + s.newsFlags[0].headline);
  if (s.risk === "High") bear.push("High risk: big swings, size it small");
  const bp = s.buyPlan;
  const verdict = s.composite >= 75 ? "Buy"
    : s.composite >= 65 ? "Accumulate"
    : s.composite >= 50 ? "Watch" : "Avoid";
  const parts = [["momentum", s.momentum / 34], ["earnings trend", s.earnings / 25], ["quality", s.quality / 15], ["valuation", s.value / 15], ["smart money", s.smart / 11]].sort((a, b) => b[1] - a[1]);
  const summary = `${s.ticker} scores ${s.composite}/100, led by ${parts[0][0]} and ${parts[1][0]}, weakest on ${parts[4][0]}. ` +
    (bp ? (bp.hot ? "It's stretched, so expect bigger swings, but buy the position at once." : "Buy the position at once.") : "");
  const watch = bp ? `The idea is wrong below $${f2(bp.stop)}.` : "";
  return { verdict, summary, bull: bull.slice(0, 3), bear: bear.slice(0, 3), watch, confidence: "rule-based", source: "rules" };
}
