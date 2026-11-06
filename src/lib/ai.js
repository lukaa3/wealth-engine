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
  const lines = [
    `Ticker: ${s.ticker} (${s.name}), sector ${s.sector}. Price $${f2(s.price)}, beta ${f2(s.beta)}.`,
    `Composite score ${s.composite}/100 = technical ${s.technical}/35, valuation ${s.fundamental}/35, Street+insiders ${s.sentiment}/30.`,
    `HTF setup: ${s.fvg.status === "None" ? "no active bullish FVG" : `${s.fvg.tf} bullish FVG ${s.fvg.status.toLowerCase()} at $${f2(s.fvg.lo)}-$${f2(s.fvg.hi)}`}; Fib depth ${s.fib ?? "none"}; structural support ${s.support ? "yes" : "no"}; plan status "${s.plan.status}"${s.plan.rr ? `, reward:risk ${s.plan.rr.toFixed(1)}:1` : ""}.`,
    `Swing plan: stop $${f2(s.stop)}, ~1-month target $${f2(s.target1m)} (${p1(s.upside1m)}). ~6-month target $${f2(s.target6m)} (${p1(s.upside6m)}). DCA zone $${f2(s.buyZone[0])}-$${f2(s.buyZone[1])} (price is ${s.zoneStatus} the zone).`,
    `Valuation: DCF $${f2(s.dcfValue)} (${p1(s.dcfUpside)} vs price), PEG ${f2(s.peg)}, P/E ${f2(s.fwdPE)} vs sector ${s.sectorPE}.`,
    `Street: ${s.buyPct == null ? "no consensus" : Math.round(s.buyPct * 100) + "% Buy of " + s.analystCount} analysts, consensus target $${f2(s.target12m)} (${p1(s.upside12m)}). Insider net 90d: $${Math.round(s.insider.net).toLocaleString("en-US")}.`,
  ];
  if (headlines.length) lines.push("Recent analyst headlines:\n" + headlines.slice(0, 6).map((h) => `- ${h.date} ${h.firm}: ${h.headline || h.action + " " + (h.toRating || "")}${h.newTarget ? " (PT $" + h.newTarget + ")" : ""}`).join("\n"));
  return lines.join("\n");
}

const SYSTEM = `You are a disciplined equity analyst writing a short note for a swing (about 1 month) and position (about 6 months) trader.
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
  const bull = [], bear = [];
  if (s.fvg.status === "Rejected") bull.push(`${s.fvg.tf} bullish FVG held and rejected at $${f2(s.fvg.lo)}–$${f2(s.fvg.hi)}`);
  if (s.fib != null && s.fib >= 0.618) bull.push(`Pulled back to the ${s.fib} Fib discount zone`);
  if (s.dcfUpside != null && s.dcfUpside >= 0.2) bull.push(`Trades ${Math.round(s.dcfUpside * 100)}% below DCF value`);
  if (s.buyPct != null && s.buyPct >= 0.75) bull.push(`${Math.round(s.buyPct * 100)}% of analysts rate it Buy`);
  if (s.insider.net >= 1e6) bull.push("Insiders are net buyers over 90 days");
  if (s.peg != null && s.peg > 0 && s.peg < 1) bull.push(`PEG ${f2(s.peg)} (growth priced cheaply)`);
  if (s.plan.status === "extended") bear.push("Price is extended above the FVG; chasing worsens reward:risk");
  if (s.plan.status === "testing") bear.push("Still testing the FVG; no rejection candle yet");
  if (s.plan.status === "none") bear.push("No bullish FVG to define risk");
  if (s.dcfUpside != null && s.dcfUpside < 0) bear.push(`Price is ${Math.round(-s.dcfUpside * 100)}% above DCF value`);
  if (s.buyPct != null && s.buyPct < 0.6) bear.push(`Only ${Math.round(s.buyPct * 100)}% Buy ratings`);
  if (s.insider.net < -5e5) bear.push("Insiders are net sellers over 90 days");
  if (s.sentiment < 12) bear.push("Weak Street support");
  const verdict = s.composite >= 85 && s.swingReady ? "Buy setup"
    : s.composite >= 70 ? (s.plan.status === "live" ? "Accumulate" : "Wait for entry")
    : s.composite >= 50 ? "Watch" : "Avoid";
  const strongest = [["technical", s.technical / 35], ["valuation", s.fundamental / 35], ["Street", s.sentiment / 30]].sort((a, b) => b[1] - a[1]);
  const summary = `${s.ticker} scores ${s.composite}/100, led by ${strongest[0][0]} and weakest on ${strongest[2][0]}. ` +
    (s.plan.status === "live" ? `The swing entry is live with ${s.plan.rr.toFixed(1)}:1 reward:risk to a ${p1(s.upside1m)} target.`
      : s.plan.status === "none" ? `There is no FVG entry, so the ${p1(s.upside6m)} 6-month view leans on valuation and the DCA zone.`
      : `Best to wait: the setup is ${s.plan.status}, with a ${p1(s.upside6m)} 6-month target.`);
  const watch = s.stop != null ? `A ${s.fvg.tf ? s.fvg.tf.toLowerCase() : "daily"} close below $${f2(s.stop)} invalidates the setup.`
    : `Watch for a pullback into the $${f2(s.buyZone[0])}–$${f2(s.buyZone[1])} DCA zone.`;
  return { verdict, summary, bull: bull.slice(0, 2), bear: bear.slice(0, 2), watch, confidence: "rule-based", source: "rules" };
}
