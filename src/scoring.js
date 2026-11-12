/**
 * scoring.js — multi-factor stock score (0–100), horizon + risk labels, a concrete buy plan, and portfolio advice.
 *
 * What drives the score (and why): these are the signals with the strongest real-world record for returns
 * over the next few months to few years — not one indicator, but agreement across several:
 *   Momentum & trend      34  12-1 month momentum rank, 6-month rank, strength vs the S&P 500, 200/50-day trend
 *   Earnings momentum     25  analysts raising vs cutting EPS estimates (4 wks), consensus change, expected EPS growth, beats
 *   Quality               15  operating margin, return on equity, free cash flow, balance sheet
 *   Valuation             15  PEG, forward P/E vs sector, cash-flow DCF (sanity-checked)
 *   Smart money & setup   11  insider buying, analyst consensus + target, and the HTF FVG (2 pts — timing only)
 * Weights were checked with a 10-year backtest (scripts/backtest.mjs): 12-1 momentum carried the edge; FVG setups
 * and "near the 52-week high" showed no predictive power, so they barely count.
 * A metric we couldn't get counts as neutral (half credit) and the stock is tagged "partial data".
 * Insider *buying* earns points; routine selling doesn't cost any.
 */

export const LIMITS = {
  HIGH_CONVICTION: 75, // "Top pick"
  RECOMMEND: 65,
  WATCH: 55,
  REVIEW_SCORE: 45,
  CONCENTRATION_LIMIT: 0.35, // one sector
  POSITION_LIMIT: 0.2, // one stock (index funds exempt)
  POSITION_TARGET: 0.15,
  UNDERWEIGHT_FLOOR: 0.1,
  ENTRY_TOLERANCE: 0.03, // price within 3% above the FVG top still counts as "entry live"
  MIN_RR: 2,
};

export const FACTORS = [
  { k: "momentum", label: "Momentum & trend", icon: "TrendingUp", max: 34 },
  { k: "earnings", label: "Earnings momentum", icon: "Activity", max: 25 },
  { k: "quality", label: "Quality", icon: "ShieldCheck", max: 15 },
  { k: "value", label: "Valuation", icon: "Scale", max: 15 },
  { k: "smart", label: "Smart money & setup", icon: "Crosshair", max: 11 },
];

export const HORIZON_INFO = {
  core: { label: "Core", span: "3–12 months", icon: "CalendarRange" },
  long: { label: "Long-term", span: "1–3+ years", icon: "Sprout" },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lin = (x, x0, x1, pts) => pts * clamp((x - x0) / (x1 - x0), 0, 1);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const isNum = (x) => x != null && isFinite(x);
const sp = (x) => (!isNum(x) ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
const pc = (x) => (!isNum(x) ? "n/a" : Math.round(x * 100) + "%");
const rel = (a, b) => (a == null || b == null || !b ? null : (a - b) / b);
const money = (x) => (x < 0 ? "-$" : "$") + (Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(x) / 1e3) + "K");
const dollars = (x) => (!isNum(x) ? "n/a" : "$" + (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)));
const FVG_SETUP = { "Weekly|Rejected": 2, "Daily|Rejected": 1.5, "Weekly|Testing": 1, "Daily|Testing": 1 };

/** Net open-market insider $ flow per ticker over the 90-day window. */
export function insiderNetByTicker(transactions) {
  const m = {};
  transactions.forEach((t) => {
    const e = (m[t.ticker] = m[t.ticker] || { net: 0, buys: 0, sells: 0 });
    e.net += t.value;
    if (t.value > 0) e.buys += t.value; else e.sells -= t.value;
  });
  return m;
}
/** Open-market purchases are a real signal; sales are mostly routine (pay, taxes, 10b5-1 plans), so they're neutral. */
function insiderPoints(ins) {
  if (ins.buys >= 1e6) return 4;
  if (ins.buys > 0) return 3;
  return 1;
}

/** Swing trade plan from the FVG: entry = FVG zone, risk to stop, reward to the 1-month target. */
function tradePlan(s) {
  if (!s.fvg || s.fvg.status === "None" || s.stop == null) {
    return { status: "none", entryMid: null, rr: null, riskPct: null };
  }
  const entryMid = (s.fvg.lo + s.fvg.hi) / 2;
  const rr = (s.target1m - entryMid) / (entryMid - s.stop);
  const riskPct = (entryMid - s.stop) / entryMid;
  let status;
  if (s.price < s.stop) status = "failed";
  else if (s.fvg.status === "Testing") status = "testing";
  else if (s.price <= s.fvg.hi * (1 + LIMITS.ENTRY_TOLERANCE)) status = "live";
  else status = "extended";
  return { status, entryMid, rr, riskPct };
}

/**
 * Concrete buy plan: three equal buys at real support levels below the price (FVG, 50-day, pullback levels, 200-day),
 * a line where the idea is wrong, and where to take profit. Plain words, actual prices.
 */
export function buyPlan(s, horizon = "core") {
  const p = s.price, f = s.factors || {};
  const fvgOn = s.fvg && s.fvg.status !== "None" && s.fvg.lo != null;
  const raw = [
    fvgOn && { v: s.fvg.hi, why: "top of the FVG" },
    fvgOn && { v: (s.fvg.lo + s.fvg.hi) / 2, why: "middle of the FVG" },
    isNum(f.ma50) && { v: f.ma50, why: "50-day average" },
    s.buyZone && isNum(s.buyZone[1]) && { v: s.buyZone[1], why: "50% pullback" },
    s.buyZone && isNum(s.buyZone[0]) && { v: s.buyZone[0], why: "78.6% pullback" },
    isNum(f.ma200) && { v: f.ma200, why: "200-day average" },
  ].filter((x) => x && x.v > p * 0.65 && x.v < p * 0.995).sort((a, b) => b.v - a.v);
  const levels = [];
  for (const l of raw) if (!levels.length || l.v < levels[levels.length - 1].v * 0.985) levels.push(l);

  const ext = isNum(f.ext50) ? f.ext50 : 0;
  const hot = ext > 0.15 || (f.rsi14 != null && f.rsi14 >= 75);
  // Entry test (10 yrs, top 20 every 3 months, 12-month hold): buying all at once +34%; thirds at these levels with no
  // deadline +24% (strong stocks often never dip); thirds with a 4-week deadline +34.4% (a tie). So: buy it all now.
  // Stretched stocks did best of all when bought at once, so they get no special treatment.
  const steps = [{ when: "now", price: p, why: hot ? "stretched, but strong stocks often keep running" : "trend is healthy" }];
  // The line where the idea is wrong: under the second support level below the price (or ~10% lower).
  const deep = levels.filter((l) => l.v <= p * 0.97)[1] || levels.filter((l) => l.v <= p * 0.97)[0];
  const base = deep ? deep.v : p * 0.9;
  const cushion = horizon === "swing" ? 0.97 : horizon === "long" ? 0.9 : 0.94;
  let stop = r2(base * cushion);
  if (horizon === "swing" && s.stop != null && s.stop < base && s.stop > base * 0.85) stop = s.stop;

  const take = horizon === "swing"
    ? { price: s.target1m, text: "Sell about half at " + dollars(s.target1m) + " (" + sp(rel(s.target1m, p)) + "), let the rest run with the stop raised to your average cost" }
    : horizon === "long"
      ? { price: s.target12m, text: (s.target12m ? "Street target " + dollars(s.target12m) + " (" + sp(rel(s.target12m, p)) + "). " : "") + "Hold while the trend and earnings stay strong; trim if it grows past 20% of your portfolio" }
      : { price: s.target6m, text: "First target " + dollars(s.target6m) + " (" + sp(rel(s.target6m, p)) + "); trim a quarter if it runs 25%+ above its 50-day average" };

  return {
    steps: steps.map((x) => ({ ...x, part: 1, share: "All" })),
    stop, stopPct: rel(stop, p), take, hot, ext,
    note: hot ? "Stretched " + sp(ext) + " above its 50-day average: expect bigger swings at first. In the test, buying stretched leaders at once still did best." : null,
  };
}

/** Low / Medium / High risk from volatility, losses, size and price. */
function riskLevel(s) {
  const f = s.factors || {};
  const loss = (isNum(f.opMargin) && f.opMargin < 0) || (isNum(s.fwdPE) && s.fwdPE <= 0);
  const v = f.vol63;
  if ((isNum(v) && v > 0.55) || loss || s.price < 5 || (isNum(f.marketCap) && f.marketCap < 2e9)) return "High";
  if ((isNum(v) && v > 0.32) || (isNum(s.beta) && s.beta > 1.5)) return "Medium";
  return isNum(v) ? "Low" : "Medium";
}

export function scoreStock(s, sectorPE, insider) {
  const f = s.factors || {};
  const pe = sectorPE[s.sector] || 20;
  const isFin = s.sector === "Financials";
  const dcfUpside = rel(s.dcfValue, s.price);
  const peDiscount = isNum(s.fwdPE) && s.fwdPE > 0 ? (pe - s.fwdPE) / pe : null;
  const upside1m = rel(s.target1m, s.price);
  const upside6m = rel(s.target6m, s.price);
  const upside12m = rel(s.target12m, s.price);
  const ins = insider || { net: 0, buys: 0, sells: 0 };
  const plan = tradePlan(s);
  const partial = [];
  const miss = (label, half) => (partial.push(label), half);

  // Momentum & trend — 34
  const m12 = isNum(f.momRank12) ? 16 * f.momRank12 : isNum(f.mom12_1) ? lin(f.mom12_1, -0.1, 0.6, 16) : miss("12-month momentum", 8);
  const m6 = isNum(f.momRank6) ? 6 * f.momRank6 : isNum(f.mom6) ? lin(f.mom6, -0.05, 0.35, 6) : miss("6-month momentum", 3);
  const rs = isNum(f.rs3) ? lin(f.rs3, -0.05, 0.1, 4) : isNum(f.mom3) ? lin(f.mom3, -0.03, 0.15, 4) : miss("relative strength", 2);
  const tr200 = f.above200 == null ? miss("200-day trend", 2) : f.above200 ? 4 : 0;
  const trX = f.golden == null ? 1.5 : f.golden ? 3 : 0;
  const trHi = isNum(f.fromHigh) ? lin(f.fromHigh, -0.35, -0.12, 1) : 0.5;
  const momentum = m12 + m6 + rs + tr200 + trX + trHi;

  // Earnings momentum — 25
  const revTot = (f.revUp || 0) + (f.revDown || 0);
  const revNet = revTot ? ((f.revUp || 0) - (f.revDown || 0)) / revTot : null;
  const eRev = f.revUp == null ? miss("estimate revisions", 4) : revTot === 0 ? 3 : lin(revNet, -0.3, 0.6, 8);
  const eCons = isNum(f.consensusChange1m) ? lin(f.consensusChange1m, -0.02, 0.04, 4) : miss("consensus change", 2);
  const eGrow = isNum(f.epsGrowthNext) ? lin(f.epsGrowthNext, 0, 0.25, 7) : f.turningProfitable ? 4 : f.epsGrowthNext === null && isNum(s.fwdPE) && s.fwdPE <= 0 ? 0 : miss("EPS growth", 3.5);
  const sur = Array.isArray(f.surprises) && f.surprises.length ? f.surprises : null;
  const beats = sur ? sur.filter((x) => x > 0).length : null;
  const avgSur = sur ? sur.reduce((a, b) => a + b, 0) / sur.length : null;
  const eSur = sur ? (beats / sur.length) * 4 + lin(avgSur, 0, 0.08, 2) : miss("earnings surprises", 3);
  const earnings = eRev + eCons + eGrow + eSur;

  // Quality — 15
  const qOp = isNum(f.opMargin) ? lin(f.opMargin, 0, 0.25, 5) : miss("operating margin", 2.5);
  const qRoe = isNum(f.roe) ? lin(f.roe, 0, 0.2, 4) : miss("return on equity", 2);
  const qFcf = isFin ? 1.5 : isNum(f.fcfYield) ? (f.fcfYield > 0 ? 1 + lin(f.fcfYield, 0, 0.05, 2) : 0) : s.dcfNm ? 0 : miss("free cash flow", 1.5);
  const qBal = isFin ? 1.5 : isNum(f.netDebtToCap) ? lin(0.5 - f.netDebtToCap, 0, 0.4, 3) : miss("balance sheet", 1.5);
  const quality = qOp + qRoe + qFcf + qBal;

  // Valuation — 15
  const vPeg = s.peg == null ? miss("PEG", 3) : s.peg <= 0 ? 0 : s.peg <= 1 ? 6 : lin(2.5 - s.peg, 0, 1.5, 6);
  const vPe = peDiscount == null ? (isNum(s.fwdPE) && s.fwdPE <= 0 ? 0 : miss("P/E", 2.5)) : lin(peDiscount, -0.3, 0.2, 5);
  const vDcf = dcfUpside == null ? (s.dcfNm ? 0 : s.dcfNa ? 2 : miss("DCF", 2)) : lin(dcfUpside, -0.2, 0.25, 4);
  const value = vPeg + vPe + vDcf;

  // Smart money & setup — 11 (FVG ≤ 2: timing only)
  const sIns = insiderPoints(ins);
  const sBuy = s.buyPct == null ? miss("analyst ratings", 1.5) : lin(s.buyPct, 0.5, 0.85, 3);
  const sPt = upside12m == null ? miss("price target", 1) : lin(upside12m, 0, 0.25, 2);
  const sSet = Math.min(2, (FVG_SETUP[s.fvg.tf + "|" + s.fvg.status] || 0) + (plan.status === "live" && plan.rr >= LIMITS.MIN_RR ? 0.5 : 0) - (plan.status === "failed" ? 1 : 0));
  const smart = sIns + sBuy + sPt + Math.max(0, sSet);

  const composite = Math.round(momentum + earnings + quality + value + smart);

  // Which holding period fits best (each 0–100).
  const swingFit = Math.round(
    lin(f.mom3 ?? 0, -0.02, 0.3, 20) + lin(f.mom1 ?? 0, -0.02, 0.15, 15) + (Math.max(0, sSet) / 2) * 10 + (plan.status === "live" ? 5 : 0)
    + ((eRev + eCons) / 12) * 25 + ((tr200 + trX + trHi) / 8) * 15 + lin(f.momRank12 ?? 0.5, 0.5, 1, 10));
  const coreFit = composite;
  const longFit = Math.round((quality / 15) * 35 + (eGrow / 7) * 15 + lin(f.revenueGrowth ?? 0, 0, 0.2, 10) + (value / 15) * 25
    + (f.above200 ? 10 : 0) + (m12 / 16) * 5 - (riskLevel(s) === "High" ? 10 : 0));
  const fits = { swing: swingFit, core: coreFit, long: longFit };
  // Long-term page: Core vs Long-term. Swing-style trades live on the Short-term page (their own tested setups).
  const horizon = fits.long > fits.core ? "long" : "core";
  const risk = riskLevel(s);
  const bp = buyPlan(s, horizon);
  const [zLo, zHi] = s.buyZone || [null, null];
  const zoneStatus = zLo == null ? "in" : s.price < zLo ? "below" : s.price > zHi ? "above" : "in";

  const techStop = s.stop != null ? (s.fvg.tf || "Daily") + " close below " + "$" + s.stop + " stop (FVG fails)" : null;
  const invalid = [
    f.above200 ? "Closes below its 200-day average (" + dollars(f.ma200) + ")" : null,
    "Analysts start cutting EPS estimates",
    "Close below " + dollars(bp.stop) + " (the plan's stop)",
  ].filter(Boolean);
  const catalysts = [
    isNum(f.mom12_1) ? "Up " + sp(f.mom12_1) + " over the past year (ex-last month)" + (isNum(f.momRank12) ? ", stronger than " + pc(f.momRank12) + " of stocks" : "") : null,
    f.revUp != null && revTot ? f.revUp + " analysts raised and " + (f.revDown || 0) + " cut EPS estimates in the last 4 weeks" : null,
    isNum(f.epsGrowthNext) ? "EPS expected to grow " + sp(f.epsGrowthNext) + " next year" : null,
    sur ? "Beat estimates " + beats + " of the last " + sur.length + " quarters" : null,
    ...(s.catalysts || []),
  ].filter(Boolean).slice(0, 4);

  return {
    ...s,
    partial, sectorPE: pe, dcfUpside, peDiscount, upside1m, upside6m, upside12m, insider: ins, plan, zoneStatus,
    swingReady: plan.status === "live" && plan.rr >= LIMITS.MIN_RR, positionReady: upside6m != null && upside6m >= 0.15,
    horizon, fits, risk, buyPlan: bp, catalysts,
    invalidationAll: techStop && horizon === "swing" ? [techStop, ...invalid] : invalid,
    momentum: r1(momentum), earnings: r1(earnings), quality: r1(quality), value: r1(value), smart: r1(smart), composite,
    // kept for older readers (AI prompt): technical ≈ setup, fundamental ≈ valuation, sentiment ≈ smart money
    technical: r1(momentum), fundamental: r1(value), sentiment: r1(smart),
    breakdown: {
      momentum: [
        { label: "12-month momentum", value: isNum(f.mom12_1) ? sp(f.mom12_1) + (isNum(f.momRank12) ? " · beats " + pc(f.momRank12) + " of stocks" : "") : "n/a", rule: "Return from 12 to 1 month ago, ranked vs ~550 stocks (the backtest's strongest signal)", pts: r1(m12), max: 16 },
        { label: "6-month momentum", value: isNum(f.mom6) ? sp(f.mom6) + (isNum(f.momRank6) ? " · beats " + pc(f.momRank6) : "") : "n/a", rule: "Ranked vs the scanned market", pts: r1(m6), max: 6 },
        { label: "Strength vs S&P 500", value: isNum(f.rs3) ? sp(f.rs3) + " vs SPY (3 mo)" : isNum(f.mom3) ? sp(f.mom3) + " (3 mo)" : "n/a", rule: "+10% vs the market = full", pts: r1(rs), max: 4 },
        { label: "Above 200-day avg", value: f.above200 == null ? "n/a" : f.above200 ? "Yes (" + dollars(f.ma200) + ")" : "No (" + dollars(f.ma200) + ")", rule: "Long-term uptrend = 4", pts: r1(tr200), max: 4 },
        { label: "50-day above 200-day", value: f.golden == null ? "n/a" : f.golden ? "Yes" : "No", rule: "Trend confirmed = 3", pts: r1(trX), max: 3 },
        { label: "Near 52-week high", value: isNum(f.fromHigh) ? sp(f.fromHigh) + " from high" : "n/a", rule: "Within 12% = full (small: no edge in backtest)", pts: r1(trHi), max: 1 },
      ],
      earnings: [
        { label: "EPS estimate revisions", value: f.revUp == null ? "n/a" : (f.revUp || 0) + " up / " + (f.revDown || 0) + " down (4 wks)", rule: "Mostly raises = full", pts: r1(eRev), max: 8 },
        { label: "Consensus change (1 mo)", value: isNum(f.consensusChange1m) ? sp(f.consensusChange1m) : "n/a", rule: "+4% = full", pts: r1(eCons), max: 4 },
        { label: "Expected EPS growth", value: isNum(f.epsGrowthNext) ? sp(f.epsGrowthNext) + " next year" : f.turningProfitable ? "Turning profitable" : "n/a", rule: "+25% = full", pts: r1(eGrow), max: 7 },
        { label: "Earnings surprises", value: sur ? beats + "/" + sur.length + " beats, avg " + sp(avgSur) : "n/a", rule: "4/4 beats and +8% avg = full", pts: r1(eSur), max: 6 },
      ],
      quality: [
        { label: "Operating margin", value: pc(f.opMargin), rule: "25%+ = full", pts: r1(qOp), max: 5 },
        { label: "Return on equity", value: pc(f.roe), rule: "20%+ = full", pts: r1(qRoe), max: 4 },
        { label: "Free cash flow", value: isFin ? "n/a for financials (neutral)" : isNum(f.fcfYield) ? sp(f.fcfYield) + " yield" : s.dcfNm ? "Negative" : "n/a", rule: "Positive and 5%+ yield = full", pts: r1(qFcf), max: 3 },
        { label: "Balance sheet", value: isFin ? "n/a for financials (neutral)" : isNum(f.netDebtToCap) ? (f.netDebtToCap <= 0 ? "Net cash" : "Net debt " + pc(f.netDebtToCap) + " of mkt cap") : "n/a", rule: "Net debt under 10% of value = full", pts: r1(qBal), max: 3 },
      ],
      value: [
        { label: "PEG ratio", value: s.peg == null ? "n/a" : s.peg <= 0 ? "n/m (loss)" : s.peg.toFixed(2), rule: "≤1.0 = full, 0 at 2.5", pts: r1(vPeg), max: 6 },
        { label: "Fwd P/E vs sector", value: !isNum(s.fwdPE) ? "n/a" : s.fwdPE <= 0 ? "n/m (expected loss)" : s.fwdPE.toFixed(1) + "x vs " + pe + "x", rule: "20% cheaper = full, 0 at 30% pricier", pts: r1(vPe), max: 5 },
        { label: "DCF value", value: s.dcfValue == null ? (s.dcfNm ? "n/m (cash burn)" : s.dcfNa ? "n/a: " + s.dcfNa : "n/a") : sp(dcfUpside) + " to " + dollars(s.dcfValue), rule: "25% upside = full (rough model)", pts: r1(vDcf), max: 4 },
      ],
      smart: [
        { label: "Insider buying (90d)", value: ins.buys > 0 ? money(ins.buys) + " bought" + (ins.sells ? ", " + money(-ins.sells) + " sold" : "") : ins.sells ? "Selling only (" + money(-ins.sells) + ")" : "No filings", rule: "≥$1M bought = 4 (selling not penalized)", pts: sIns, max: 4 },
        { label: "Analyst consensus", value: s.buyPct == null ? "n/a" : Math.round(s.buyPct * 100) + "% Buy of " + s.analystCount, rule: "85%+ Buy = full", pts: r1(sBuy), max: 3 },
        { label: "12-mo price target", value: s.target12m == null ? "n/a" : sp(upside12m) + " to " + dollars(s.target12m), rule: "25%+ = full", pts: r1(sPt), max: 2 },
        { label: "FVG entry setup", value: s.fvg.status === "None" ? "None" : s.fvg.tf + " " + s.fvg.status.toLowerCase() + " " + dollars(s.fvg.lo) + "–" + dollars(s.fvg.hi) + (plan.status === "live" ? " · entry live" : ""), rule: "Weekly rejection 2 · Daily 1.5 · testing 1 (timing only: no edge in backtest)", pts: Math.max(0, sSet), max: 2 },
      ],
    },
  };
}

export function scoreUniverse(stocks, sectorPE, insiderTransactions) {
  const ins = insiderNetByTicker(insiderTransactions);
  return stocks.map((s) => scoreStock(s, sectorPE, ins[s.ticker]));
}

/** Sectors the rebalancer leaves alone (no concentration or underweight alerts). */
export const UNMANAGED_SECTORS = ["Cash", "Other", "Index Funds"];

const ACTION_RANK = { Sell: 0, Trim: 1, Review: 2, "Buy more": 3, "Pause adding": 4, Hold: 5 };

/**
 * One holding → what to do now. Uses the full score when we have it (stocks), otherwise the chart (ETFs/funds).
 *   Sell        trend broken (below 200-day, 50 under 200, falling) and the score is weak — the reason to own it is gone
 *   Trim        position too big (> 20% of the portfolio), or a big winner that's stretched far above its 50-day
 *   Review      bad headlines or analyst downgrades this week, or estimates being cut — check before adding
 *   Buy more    strong score, uptrend, and price at/near a buy level from the plan
 *   Hold        everything else
 * `downgrades` = recent analyst downgrades / target cuts for this ticker (from the analyst feed).
 */
export function adviseHolding(r, s, chart, { downgrades = [] } = {}) {
  const f = (s && s.factors) || chart || {};
  const isIndex = r.sector === "Index Funds";
  const isFund = !s;
  const why = [];
  let action = "Hold";
  const trendBroken = f.above200 === false && f.golden === false && ((f.mom3 ?? 0) < -0.05 || (f.mom6 ?? 0) < -0.1);
  const stretched = isNum(f.ext50) && f.ext50 > 0.2;
  const news = (s && s.newsFlags) || [];
  const revCut = s && s.factors && (s.factors.revDown || 0) > (s.factors.revUp || 0) + 1;

  if (!isFund) {
    if (trendBroken && s.composite < 50) {
      action = "Sell";
      why.push("Downtrend: below its 200-day average with the 50-day under it, and the score is only " + s.composite);
    } else if (s.plan.status === "failed" && s.horizon === "swing" && s.composite < 60) {
      action = "Sell";
      why.push("Swing setup failed: closed under the " + dollars(s.stop) + " FVG stop");
    }
  } else if (trendBroken && !isIndex) {
    action = "Pause adding";
    why.push("In a downtrend (below its 200-day average); hold, but don't add until it turns");
  }

  if (action === "Hold" && !isIndex && r.weight > LIMITS.POSITION_LIMIT) {
    action = "Trim";
    why.push(Math.round(r.weight * 100) + "% of your portfolio in one name; trim about " + dollars(r.value - LIMITS.POSITION_TARGET * r.total) + " to get back to ~" + Math.round(LIMITS.POSITION_TARGET * 100) + "%");
  } else if (action === "Hold" && stretched && r.plPct > 0.25) {
    action = "Trim";
    why.push("Up " + Math.round(r.plPct * 100) + "% and stretched " + sp(f.ext50) + " above its 50-day average: take some profit (about a quarter)");
  } else if (action === "Hold" && s && s.composite < LIMITS.REVIEW_SCORE && !trendBroken) {
    action = "Pause adding";
    why.push("Weak score (" + s.composite + "): hold what you have, don't add; " + (f.above200 === false
      ? "it's already under its 200-day average" + (isNum(f.ma200) ? " (" + dollars(f.ma200) + ")" : "") + ", so sell if the 50-day crosses under it too"
      : "sell if it breaks below its 200-day average" + (isNum(f.ma200) ? " (" + dollars(f.ma200) + ")" : "")));
  }

  const weak = !s || s.composite < LIMITS.RECOMMEND;
  if ((action === "Hold" || action === "Buy more") && (news.length >= 2 || (news.length && weak) || downgrades.length >= 2 || revCut)) {
    action = "Review";
    if (news.length) why.push("Negative headline" + (news.length > 1 ? "s" : "") + " this week: " + news[0].headline);
    if (downgrades.length) why.push(downgrades.length + " analyst downgrade" + (downgrades.length > 1 ? "s" : "") + " / target cut" + (downgrades.length > 1 ? "s" : "") + " in the last 30 days");
    if (revCut) why.push("Analysts are cutting EPS estimates (" + s.factors.revDown + " down vs " + (s.factors.revUp || 0) + " up)");
  }

  if (action === "Hold") {
    if (s) {
      const bp = s.buyPlan;
      if (s.composite >= LIMITS.RECOMMEND && f.above200 && bp && r.weight < LIMITS.POSITION_TARGET) {
        action = "Buy more";
        why.push("Score " + s.composite + " and in an uptrend: add up to about " + Math.round(LIMITS.POSITION_TARGET * 100) + "% of your portfolio, all at once; rethink below " + dollars(bp.stop));
      } else {
        why.push(s.composite >= LIMITS.RECOMMEND ? "Strong score (" + s.composite + "); keep holding"
          : "Score " + s.composite + ": fine to hold, not a top add right now");
      }
    } else if (f.above200 && isNum(f.ext50) && Math.abs(f.ext50) <= 0.03 && r.weight < (isIndex ? 0.5 : LIMITS.POSITION_TARGET)) {
      action = "Buy more";
      why.push("Uptrend and pulled back to its 50-day average (" + dollars(f.ma50) + "), a good spot to add");
    } else {
      why.push(f.above200 ? "Uptrend intact" + (isIndex ? "; a steady core holding" : "") : f.above200 === false ? "Below its 200-day average; hold, add only when it recovers" : "Too new to read a trend yet (under 200 days of history); hold");
    }
  }
  if (action !== "Review" && news.length) why.push("Headline to check: " + news[0].headline);
  return { action, why, rank: ACTION_RANK[action] ?? 5 };
}

/** Portfolio math, per-holding advice, and portfolio-level signals. */
export function analyzePortfolio(holdings, byTicker, sectors, sectorColors, priceBook = {}, { analyst = [] } = {}) {
  const rows = holdings
    .map((h) => {
      const pb = priceBook[h.ticker];
      if (h.ticker !== "CASH" && !byTicker[h.ticker] && pb && pb.price) {
        // In the market scan (chart data only): live price, sector and trend, but no full score.
        const value = h.shares * pb.price, costBasis = h.shares * h.cost;
        return { id: h.id, ticker: h.ticker, name: pb.name || h.ticker, sector: pb.sector || "Other", shares: h.shares, cost: h.cost, price: pb.price,
          value, costBasis, pl: value - costBasis, plPct: costBasis ? (value - costBasis) / costBasis : 0, beta: 1, score: null, stock: null, chart: pb, scanOnly: true, fund: !!pb.fund };
      }
      if (h.ticker !== "CASH" && !byTicker[h.ticker]) {
        // Ticker missing from the current data source: carry at cost so the holding doesn't vanish.
        const v = h.shares * h.cost;
        return { id: h.id, ticker: h.ticker, name: "No data for this ticker", sector: "Other", shares: h.shares, cost: h.cost, price: h.cost,
          value: v, costBasis: v, pl: 0, plPct: 0, beta: 1, score: null, stock: null, unpriced: true };
      }
      if (h.ticker === "CASH") {
        return { id: h.id, ticker: "CASH", name: "Cash", sector: "Cash", shares: h.shares, cost: 1, price: 1, value: h.shares,
          costBasis: h.shares, pl: 0, plPct: 0, beta: 0, score: null, stock: null };
      }
      const s = byTicker[h.ticker];
      const value = h.shares * s.price, costBasis = h.shares * h.cost;
      return { id: h.id, ticker: h.ticker, name: s.name, sector: s.sector, shares: h.shares, cost: h.cost, price: s.price, value, costBasis,
        pl: value - costBasis, plPct: costBasis ? (value - costBasis) / costBasis : 0, beta: s.beta, score: s.composite, stock: s, chart: priceBook[h.ticker] || null };
    });

  const total = rows.reduce((a, r) => a + r.value, 0);
  const invested = rows.filter((r) => r.ticker !== "CASH");
  const costTotal = invested.reduce((a, r) => a + r.costBasis, 0);
  const pl = invested.reduce((a, r) => a + r.value, 0) - costTotal;
  const beta = total ? rows.reduce((a, r) => a + r.beta * r.value, 0) / total : 0;
  rows.forEach((r) => { r.weight = total ? r.value / total : 0; r.total = total; });

  // Per-holding advice.
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const bad = {};
  analyst.filter((a) => a.date >= since && (a.action === "Downgrade" || a.action === "PT Cut")).forEach((a) => (bad[a.ticker] = bad[a.ticker] || []).push(a));
  rows.forEach((r) => {
    if (r.ticker === "CASH" || r.unpriced) { r.advice = null; return; }
    r.advice = adviseHolding(r, r.stock, r.chart, { downgrades: bad[r.ticker] || [] });
  });

  const sectorRows = sectors.map((sec) => {
    const v = rows.filter((r) => r.sector === sec).reduce((a, r) => a + r.value, 0);
    return { sector: sec, value: v, weight: total ? v / total : 0, color: sectorColors[sec] || "#9085e9" };
  });

  const feed = [];
  rows.filter((r) => r.advice && r.advice.action !== "Hold").sort((a, b) => a.advice.rank - b.advice.rank || b.weight - a.weight)
    .forEach((r) => feed.push({ type: "advice", ticker: r.ticker, name: r.name, action: r.advice.action, why: r.advice.why, weight: r.weight, score: r.score, plPct: r.plPct }));

  let trimProceeds = 0;
  sectorRows.filter((s) => !UNMANAGED_SECTORS.includes(s.sector) && s.weight > LIMITS.CONCENTRATION_LIMIT).forEach((s) => {
    const excess = s.value - LIMITS.CONCENTRATION_LIMIT * total;
    trimProceeds += excess;
    const trimFirst = rows.filter((r) => r.sector === s.sector).sort((a, b) => (a.score ?? 60) - (b.score ?? 60)).slice(0, 2).map((r) => r.ticker);
    feed.push({ type: "concentration", sector: s.sector, weight: s.weight, excess, trimFirst });
  });
  const cash = (sectorRows.find((s) => s.sector === "Cash") || { value: 0 }).value;
  const funding = trimProceeds + cash;

  // Risk mix: how much sits in high-risk names.
  const highRisk = rows.filter((r) => r.stock && r.stock.risk === "High").reduce((a, r) => a + r.value, 0);
  const riskShare = total ? highRisk / total : 0;
  if (riskShare > 0.4) feed.push({ type: "risk", share: riskShare, names: rows.filter((r) => r.stock && r.stock.risk === "High").map((r) => r.ticker) });

  // Ideas: best-scoring stocks you don't own, preferring sectors you're light in.
  const held = new Set(rows.map((r) => r.ticker));
  const light = new Set(sectorRows.filter((s) => !UNMANAGED_SECTORS.includes(s.sector) && s.weight < LIMITS.UNDERWEIGHT_FLOOR).map((s) => s.sector));
  const ideas = Object.values(byTicker)
    .filter((x) => !held.has(x.ticker) && x.composite >= LIMITS.RECOMMEND)
    .sort((a, b) => (light.has(b.sector) - light.has(a.sector)) || b.composite - a.composite)
    .slice(0, 3);
  ideas.forEach((x) => feed.push({ type: "add", sector: x.sector, light: light.has(x.sector), weight: (sectorRows.find((s) => s.sector === x.sector) || {}).weight || 0, stock: x }));

  const counts = {};
  rows.forEach((r) => { if (r.advice) counts[r.advice.action] = (counts[r.advice.action] || 0) + 1; });
  return { rows, total, costTotal, pl, plPct: costTotal ? pl / costTotal : 0, beta, sectors: sectorRows, feed, funding, trimProceeds, cash, riskShare, counts };
}

/**
 * How big a position should be, as a share of the whole portfolio. With roughly half in index funds and 8–15 picks,
 * no single stock can sink you: Low risk 8%, Medium 5%, High 3%; Top picks get 25% more (max 10%).
 */
export const SIZE_BY_RISK = { Low: 0.08, Medium: 0.05, High: 0.03 };
export function suggestedSize(s, total) {
  let pct = SIZE_BY_RISK[s.risk] || 0.05;
  if (s.composite >= LIMITS.HIGH_CONVICTION) pct *= 1.25;
  pct = Math.min(pct, 0.1);
  return { pct, amount: total > 0 ? total * pct : null };
}

/**
 * "I have $X to invest" → what to buy now. Tops up the index-fund core toward ~50% (with up to half the money),
 * then funds the buy of: holdings marked Buy more, Top picks you don't own, then Recommended ones —
 * each sized by suggestedSize(), at most 2 new names per sector. Leftover goes to the core fund.
 */
export function planNewMoney(cash, a, scored, { coreTarget = 0.5, maxBuys = 6 } = {}) {
  const items = [];
  if (!(cash > 0)) return { items, total: a.total };
  const total = a.total + cash;
  let left = cash;
  const coreRows = a.rows.filter((r) => r.sector === "Index Funds");
  const coreVal = coreRows.reduce((x, r) => x + r.value, 0);
  const pickCore = coreRows.slice().sort((x, y) => ((y.advice && y.advice.action === "Buy more") - (x.advice && x.advice.action === "Buy more")) || y.value - x.value)[0];
  const coreTicker = pickCore ? pickCore.ticker : "SPY";
  const coreNeed = Math.max(0, coreTarget * total - coreVal);
  const coreBuy = Math.min(left * 0.5, coreNeed);
  if (coreBuy >= 10) {
    items.push({ ticker: coreTicker, amount: coreBuy, kind: "core", why: "Index funds are " + Math.round((a.total ? coreVal / a.total : 0) * 100) + "% of your portfolio; ~50% keeps you steady" });
    left -= coreBuy;
  }
  const held = Object.fromEntries(a.rows.map((r) => [r.ticker, r]));
  const bySector = {};
  const desc = (x, y) => y.composite - x.composite;
  const cands = [
    ...a.rows.filter((r) => r.stock && r.advice && r.advice.action === "Buy more").map((r) => r.stock).sort(desc),
    ...scored.filter((s) => !held[s.ticker] && s.composite >= LIMITS.HIGH_CONVICTION).sort(desc),
    ...scored.filter((s) => !held[s.ticker] && s.composite >= LIMITS.RECOMMEND && s.composite < LIMITS.HIGH_CONVICTION && s.buyPlan).sort(desc),
  ];
  const seen = new Set();
  for (const s of cands) {
    if (left < 10 || items.filter((x) => x.kind !== "core").length >= maxBuys) break;
    if (seen.has(s.ticker)) continue;
    seen.add(s.ticker);
    if (!held[s.ticker] && (bySector[s.sector] || 0) >= 2) continue;
    const size = suggestedSize(s, total);
    const have = held[s.ticker] ? held[s.ticker].value : 0;
    const need = size.amount - have;
    if (need < 10) continue;
    const now = Math.min(left, Math.max(10, need));
    items.push({ ticker: s.ticker, amount: now, kind: held[s.ticker] ? "add" : "new", target: size.amount, pct: size.pct, stock: s, later: [] });
    if (!held[s.ticker]) bySector[s.sector] = (bySector[s.sector] || 0) + 1;
    left -= now;
  }
  if (left >= 1) {
    const core = items.find((x) => x.kind === "core");
    if (core) { core.amount += left; core.why += " (plus what's left over)"; }
    else items.push({ ticker: coreTicker, amount: left, kind: "core", why: "What's left goes to your index-fund core" });
  }
  return { items, total };
}

