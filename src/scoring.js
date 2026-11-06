/**
 * scoring.js — Composite Swing + Position Scorer (0–100) and portfolio analytics.
 *   HTF Technical Setup        35  (bullish FVG rejection, Fib 0.618+ confluence, structural support)
 *   Fundamental Value          35  (DCF discount, PEG, forward P/E vs sector)
 *   Wall Street & Insiders     30  (buy consensus, 12-mo price-target upside, net insider buying)
 * Linear partial credit between thresholds.
 */

export const LIMITS = {
  HIGH_CONVICTION: 85,
  RECOMMEND: 70,
  REVIEW_SCORE: 50,
  CONCENTRATION_LIMIT: 0.35,
  UNDERWEIGHT_FLOOR: 0.15,
  ENTRY_TOLERANCE: 0.03, // price within 3% above the FVG top still counts as "entry live"
  MIN_RR: 2,
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lin = (x, x0, x1, pts) => pts * clamp((x - x0) / (x1 - x0), 0, 1);
const r1 = (x) => Math.round(x * 10) / 10;
const sp = (x) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
const rel = (a, b) => (a == null || b == null || !b ? null : (a - b) / b);
const money = (x) => (x < 0 ? "-$" : "$") + (Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(x) / 1e3) + "K");
const FVG_POINTS = { "Weekly|Rejected": 20, "Daily|Rejected": 16, "Weekly|Testing": 10, "Daily|Testing": 8 };

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
function insiderPoints(net) {
  if (net >= 1e6) return 8;
  if (net > 0) return 5;
  if (net >= -5e5) return 2;
  return 0;
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

export function scoreStock(s, sectorPE, insider) {
  const pe = sectorPE[s.sector] || 20;
  const dcfUpside = rel(s.dcfValue, s.price);
  const peDiscount = s.fwdPE != null && s.fwdPE > 0 ? (pe - s.fwdPE) / pe : null;
  const upside1m = rel(s.target1m, s.price);
  const upside6m = rel(s.target6m, s.price);
  const upside12m = rel(s.target12m, s.price);
  const ins = insider || { net: 0, buys: 0, sells: 0 };
  const plan = tradePlan(s);

  // HTF Technical Setup — 35
  const tFvg = FVG_POINTS[s.fvg.tf + "|" + s.fvg.status] || 0;
  const tFib = s.fib != null && s.fib >= 0.618 ? 10 : s.fib === 0.5 ? 4 : 0;
  const tSup = s.support ? 5 : 0;
  const technical = tFvg + tFib + tSup;

  // Fundamental Value — 35
  const fDcf = dcfUpside == null ? 0 : lin(dcfUpside, 0, 0.2, 15);
  const fPeg = s.peg == null || s.peg <= 0 ? 0 : s.peg < 1 ? 10 : lin(2 - s.peg, 0, 1, 10);
  const fPe = peDiscount == null ? 0 : lin(peDiscount, 0, 0.2, 10);
  const fundamental = fDcf + fPeg + fPe;

  // Wall Street & Insider Sentiment — 30
  const sBuy = s.buyPct == null ? 0 : lin(s.buyPct, 0.5, 0.75, 10);
  const sPt = upside12m == null ? 0 : lin(upside12m, 0, 0.25, 12);
  const sIns = insiderPoints(ins.net);
  const sentiment = sBuy + sPt + sIns;

  const composite = Math.round(technical + fundamental + sentiment);
  const [zLo, zHi] = s.buyZone || [null, null];
  const zoneStatus = zLo == null ? "in" : s.price < zLo ? "below" : s.price > zHi ? "above" : "in";

  // Horizon fit
  const swingReady = plan.status === "live" && plan.rr >= LIMITS.MIN_RR;
  const positionReady = upside6m != null && upside6m >= 0.15;

  const techStop = s.stop != null ? (s.fvg.tf || "Daily") + " close below " + "$" + s.stop + " stop (FVG fails)" : null;

  return {
    ...s,
    sectorPE: pe, dcfUpside, peDiscount, upside1m, upside6m, upside12m, insider: ins, plan, zoneStatus, swingReady, positionReady,
    invalidationAll: techStop ? [techStop, ...s.invalidation] : s.invalidation,
    technical: r1(technical), fundamental: r1(fundamental), sentiment: r1(sentiment), composite,
    breakdown: {
      technical: [
        { label: "Bullish FVG", value: s.fvg.status === "None" ? "None" : s.fvg.tf + " " + s.fvg.status.toLowerCase() + " $" + s.fvg.lo + "–$" + s.fvg.hi, rule: "Weekly rejection 20 · Daily 16 · testing 8–10", pts: tFvg, max: 20 },
        { label: "Fib discount array", value: s.fib == null ? "None" : s.fib.toFixed(3), rule: "0.618+ = 10, 0.5 = 4", pts: tFib, max: 10 },
        { label: "Structural support", value: s.support ? "Confluent" : "No", rule: "Confluence = 5", pts: tSup, max: 5 },
      ],
      fundamental: [
        { label: "DCF discount", value: s.dcfValue == null ? "n/a" : sp(dcfUpside) + " to $" + s.dcfValue, rule: "≥20% below fair value = full", pts: r1(fDcf), max: 15 },
        { label: "PEG ratio", value: s.peg == null ? "n/m" : s.peg.toFixed(2), rule: "<1.0 = full, 0 at 2.0", pts: r1(fPeg), max: 10 },
        { label: "Fwd P/E vs sector", value: s.fwdPE == null ? "n/a" : s.fwdPE.toFixed(1) + "x vs " + pe + "x", rule: "≥20% discount = full", pts: r1(fPe), max: 10 },
      ],
      sentiment: [
        { label: "Buy consensus", value: s.buyPct == null ? "n/a" : Math.round(s.buyPct * 100) + "% of " + s.analystCount, rule: "≥75% Buy = full, 0 at 50%", pts: r1(sBuy), max: 10 },
        { label: "12-mo PT upside", value: s.target12m == null ? "n/a" : sp(upside12m) + " to $" + s.target12m, rule: "≥25% = full", pts: r1(sPt), max: 12 },
        { label: "Net insider buying (90d)", value: ins.net === 0 ? "No filings" : money(ins.net), rule: "≥$1M net buy = 8, net sell = 0", pts: sIns, max: 8 },
      ],
    },
  };
}

export function scoreUniverse(stocks, sectorPE, insiderTransactions) {
  const ins = insiderNetByTicker(insiderTransactions);
  return stocks.map((s) => scoreStock(s, sectorPE, ins[s.ticker]));
}

/** Portfolio math + rebalancing signals. holdings: [{id, ticker, shares, cost}], byTicker: scored map. */
export function analyzePortfolio(holdings, byTicker, sectors, sectorColors) {
  const rows = holdings
    .map((h) => {
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
        pl: value - costBasis, plPct: costBasis ? (value - costBasis) / costBasis : 0, beta: s.beta, score: s.composite, stock: s };
    });

  const total = rows.reduce((a, r) => a + r.value, 0);
  const invested = rows.filter((r) => r.ticker !== "CASH");
  const costTotal = invested.reduce((a, r) => a + r.costBasis, 0);
  const pl = invested.reduce((a, r) => a + r.value, 0) - costTotal;
  const beta = total ? rows.reduce((a, r) => a + r.beta * r.value, 0) / total : 0;
  rows.forEach((r) => (r.weight = total ? r.value / total : 0));

  const sectorRows = sectors.map((sec) => {
    const v = rows.filter((r) => r.sector === sec).reduce((a, r) => a + r.value, 0);
    return { sector: sec, value: v, weight: total ? v / total : 0, color: sectorColors[sec] || "#9085e9" };
  });

  const feed = [];
  // Technical stop breaches first — most time-sensitive.
  rows.filter((r) => r.stock && r.stock.stop != null && r.price < r.stock.stop)
    .forEach((r) => feed.push({ type: "stop", ticker: r.ticker, price: r.price, stop: r.stock.stop, weight: r.weight }));

  let trimProceeds = 0;
  sectorRows.filter((s) => s.sector !== "Cash" && s.sector !== "Other" && s.weight > LIMITS.CONCENTRATION_LIMIT).forEach((s) => {
    const excess = s.value - LIMITS.CONCENTRATION_LIMIT * total;
    trimProceeds += excess;
    const trimFirst = rows.filter((r) => r.sector === s.sector).sort((a, b) => (a.score || 0) - (b.score || 0)).slice(0, 2).map((r) => r.ticker);
    feed.push({ type: "concentration", sector: s.sector, weight: s.weight, excess, trimFirst });
  });
  const cash = sectorRows.find((s) => s.sector === "Cash").value;
  const funding = trimProceeds + cash;

  const held = new Set(rows.map((r) => r.ticker));
  const needs = sectorRows
    .filter((s) => s.sector !== "Cash" && s.sector !== "Other" && s.weight < LIMITS.UNDERWEIGHT_FLOOR)
    .map((s) => {
      const pick = Object.values(byTicker)
        .filter((x) => x.sector === s.sector && x.composite >= LIMITS.HIGH_CONVICTION && !held.has(x.ticker))
        .sort((a, b) => b.composite - a.composite)[0];
      return { sector: s.sector, weight: s.weight, need: Math.max(0, LIMITS.UNDERWEIGHT_FLOOR * total - s.value), pick };
    })
    .filter((n) => n.pick);
  const totalNeed = needs.reduce((a, n) => a + n.need, 0);
  const scale = totalNeed > 0 ? Math.min(1, funding / totalNeed) : 0;
  needs.forEach((n) => {
    const amount = n.need * scale;
    feed.push({ type: "add", sector: n.sector, weight: n.weight, stock: n.pick, amount, shares: Math.floor(amount / n.pick.price) });
  });

  rows.filter((r) => r.score != null && r.score < LIMITS.REVIEW_SCORE).sort((a, b) => a.score - b.score)
    .forEach((r) => feed.push({ type: "review", ticker: r.ticker, name: r.name, score: r.score, weight: r.weight, pl: r.pl }));

  return { rows, total, costTotal, pl, plPct: costTotal ? pl / costTotal : 0, beta, sectors: sectorRows, feed, funding, trimProceeds, cash };
}
