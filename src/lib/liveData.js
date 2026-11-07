/**
 * liveData.js — builds app-shaped stock / analyst / insider records from the providers.
 * Shared by the browser (live mode) and scripts/update-screener.mjs (GitHub Action).
 * Missing fields stay null; the scorer gives them 0 points and the UI shows "n/a".
 */
import { deriveSetup } from "./technicals.js";
import { mapLimit } from "./providers.js";

const safe = async (p, errors, label) => {
  if (!p) return null;
  try { return await p(); } catch (e) { errors.push(label + ": " + (e.message || e)); return null; }
};
const pick = (...vals) => { for (const v of vals) if (v != null && v !== "" && isFinite(v)) return Number(v); return null; };

/** Vendor sector names → the app's sector buckets. */
export function mapSector(name) {
  const n = String(name || "").toLowerCase();
  if (/tech|communication/.test(n)) return "Technology";
  if (/financ|bank|insur/.test(n)) return "Financials";
  if (/health|pharma|biotech|medical/.test(n)) return "Healthcare";
  if (/consumer|retail|staples|cyclical|defensive/.test(n)) return "Consumer";
  if (/energy|oil|gas/.test(n)) return "Energy";
  return "Other";
}

/** One ticker → stock record (same shape as mockData.stocks). `base` supplies text fields if we have them. */
export async function buildLiveStock(ticker, P, base) {
  // `base` (optional) only supplies the sector bucket for tickers we already know.
  const errors = [];
  const { fmp, finnhub, alpha } = P;
  const fhQuote = await safe(finnhub && (() => finnhub.quote(ticker)), errors, "finnhub quote");
  const fq = fhQuote ? null : await safe(fmp && (() => fmp.quote(ticker)), errors, "fmp quote");
  const price = pick(fhQuote && fhQuote.price, fq && fq.price);
  if (!price) return { ticker, error: errors.join("; ") || "no quote" };

  const [profile, dcf, pt, gc, ratios, rec, metric] = await Promise.all([
    safe(fmp && (() => fmp.profile(ticker)), errors, "fmp profile"),
    safe(fmp && (() => fmp.dcf(ticker)), errors, "fmp dcf"),
    safe(fmp && (() => fmp.priceTarget(ticker)), errors, "fmp price target"),
    safe(fmp && (() => fmp.gradesConsensus(ticker)), errors, "fmp grades consensus"),
    safe(fmp && (() => fmp.ratiosTtm(ticker)), errors, "fmp ratios"),
    safe(finnhub && (() => finnhub.recommendation(ticker)), errors, "finnhub recommendation"),
    safe(finnhub && (() => finnhub.metric(ticker)), errors, "finnhub metric"),
  ]);
  // Alpha Vantage only fills gaps (PEG, P/E, price target, analyst ratings) — it has a tiny free quota.
  const needsAv = !(ratios && (ratios.priceToEarningsGrowthRatioTTM != null || ratios.pegRatioTTM != null))
    || !(pt && pt.targetConsensus) || !(gc && gc.strongBuy != null) && !(rec && rec.strongBuy != null);
  const ov = needsAv ? await safe(alpha && (() => alpha.overview(ticker)), errors, "alpha vantage overview") : null;
  let daily = await safe(fmp && (() => fmp.daily(ticker)), errors, "fmp candles");
  if (!daily || daily.length < 30) daily = await safe(alpha && (() => alpha.daily(ticker)), errors, "alpha vantage candles");
  daily = (daily || []).slice(-260);

  // Analyst consensus: FMP grades consensus → Finnhub recommendation trends → Alpha Vantage overview
  const counts = gc && gc.strongBuy != null ? gc : rec && rec.strongBuy != null ? rec
    : ov ? { strongBuy: +ov.AnalystRatingStrongBuy || 0, buy: +ov.AnalystRatingBuy || 0, hold: +ov.AnalystRatingHold || 0, sell: +ov.AnalystRatingSell || 0, strongSell: +ov.AnalystRatingStrongSell || 0 } : null;
  const total = counts ? (counts.strongBuy || 0) + (counts.buy || 0) + (counts.hold || 0) + (counts.sell || 0) + (counts.strongSell || 0) : 0;
  const buyPct = total ? ((counts.strongBuy || 0) + (counts.buy || 0)) / total : null;

  const target12m = pick(pt && pt.targetConsensus, pt && pt.targetMedian, ov && ov.AnalystTargetPrice);
  const setup = deriveSetup({ daily, price, ptConsensus: target12m });

  const stock = {
    ticker,
    name: (fq && fq.name) || (profile && profile.companyName) || (ov && ov.Name) || (base && base.name) || ticker,
    sector: base ? base.sector : mapSector((profile && profile.sector) || (ov && ov.Sector)),
    price,
    beta: pick(profile && profile.beta, ov && ov.Beta, metric && metric.beta, 1),
    dcfValue: pick(dcf && dcf.dcf),
    peg: pick(ov && ov.PEGRatio, ratios && ratios.priceToEarningsGrowthRatioTTM, ratios && ratios.pegRatioTTM),
    fwdPE: pick(ov && ov.ForwardPE, ratios && ratios.priceToEarningsRatioTTM, ratios && ratios.peRatioTTM, metric && metric.peTTM),
    fvg: setup ? setup.fvg : { tf: null, status: "None", lo: null, hi: null },
    fib: setup ? setup.fib : null,
    support: setup ? setup.support : false,
    stop: setup ? setup.stop : null,
    target1m: setup ? setup.target1m : Math.round(price * 110) / 100,
    target6m: setup ? setup.target6m : Math.round(price * 115) / 100,
    target12m,
    buyPct,
    analystCount: total || null,
    buyZone: setup ? setup.buyZone : [Math.round(price * 90) / 100, Math.round(price * 97) / 100],
    // Narrative text isn't in free APIs; generated from the data (sample-universe prose is never mixed into live rows).
    catalysts: [],
    invalidation: [],
    live: true,
    dataNotes: errors,
  };
  const dcfGap = stock.dcfValue ? (stock.dcfValue - price) / price : null;
  stock.catalysts = [
    buyPct != null ? Math.round(buyPct * 100) + "% of " + total + " analysts rate it Buy" : "No analyst consensus available",
    target12m ? "Street target $" + target12m.toFixed(2) + " (" + (target12m >= price ? "+" : "") + (((target12m - price) / price) * 100).toFixed(0) + "%)" : "No consensus price target",
    dcfGap != null ? "DCF value $" + stock.dcfValue.toFixed(2) + " (" + (dcfGap >= 0 ? "+" : "") + (dcfGap * 100).toFixed(0) + "% vs price)" : null,
  ].filter(Boolean);
  stock.invalidation = [
    "Consensus slipping below 50% Buy",
    stock.buyZone[0] ? "Close below the $" + stock.buyZone[0] + " DCA zone low" : "Losing the recent swing low",
  ];
  return stock;
}

export async function buildLiveUniverse(tickers, P, baseByTicker = {}, onProgress) {
  let done = 0;
  const res = await mapLimit(tickers, 3, async (t) => {
    const s = await buildLiveStock(t, P, baseByTicker[t]);
    done++; if (onProgress) onProgress(done, tickers.length);
    return s;
  });
  return {
    stocks: res.filter((s) => s && s.price),
    failed: res.filter((s) => s && !s.price).map((s) => s.ticker + (s.error ? " (" + s.error + ")" : "")),
  };
}

const ACTION_MAP = { upgrade: "Upgrade", downgrade: "Downgrade", maintain: "Reiterate", reiterated: "Reiterate", init: "Initiate", initialise: "Initiate", initiated: "Initiate" };

/* ---------------------- Analyst headline parser (news → rating action) ---------------------- */
const FIRMS = ["Goldman Sachs", "Morgan Stanley", "JPMorgan", "J.P. Morgan", "BofA Securities", "Bank of America", "BofA", "Citigroup", "Citi",
  "Wells Fargo", "Barclays", "UBS", "Deutsche Bank", "Jefferies", "Evercore ISI", "Evercore", "Bernstein", "Piper Sandler", "Raymond James",
  "KeyBanc", "Truist", "Mizuho", "Needham", "Oppenheimer", "Wedbush", "Cantor Fitzgerald", "Baird", "BMO Capital", "BMO", "RBC Capital", "RBC",
  "TD Cowen", "Cowen", "Stifel", "Loop Capital", "Rosenblatt", "HSBC", "Macquarie", "Guggenheim", "William Blair", "Benchmark", "B. Riley",
  "Argus", "Morningstar", "Bernstein SocGen", "Susquehanna", "Wolfe Research", "Redburn", "Melius", "Seaport", "Daiwa", "Nomura", "Citizens JMP",
  "Telsey", "Roth", "Northland", "DA Davidson", "D.A. Davidson", "Craig-Hallum", "Scotiabank", "CIBC", "Bernstein Research", "Erste", "Exane BNP Paribas", "BNP Paribas"];
const RATING = "(Strong Buy|Buy|Overweight|Outperform|Accumulate|Positive|Neutral|Hold|Equal[- ]?Weight|Market Perform|Sector Perform|In-?Line|Peer Perform|Underweight|Underperform|Reduce|Sell|Strong Sell)";
const ANALYST_RE = /\b(upgrade[sd]?|downgrade[sd]?|price target|PT\b|initiat|reiterat|maintains?|coverage|target to \$|outperform|overweight|underweight)/i;
const toMoney = (x) => (x == null ? null : Number(String(x).replace(/,/g, "")));

export function parseAnalystHeadline(headline, summary = "") {
  const text = (headline || "") + " " + (summary || "").slice(0, 400);
  if (!ANALYST_RE.test(headline || "")) return null;
  const h = headline;

  let oldTarget = null, newTarget = null, m;
  if ((m = text.match(/from\s+\$\s?([\d,.]+)\s+to\s+\$\s?([\d,.]+)/i))) { oldTarget = toMoney(m[1]); newTarget = toMoney(m[2]); }
  else if ((m = text.match(/to\s+\$\s?([\d,.]+)\s*(?:\(|,)?\s*from\s+\$\s?([\d,.]+)/i))) { newTarget = toMoney(m[1]); oldTarget = toMoney(m[2]); }
  else if ((m = text.match(/(?:price target|PT|target)[^$]{0,30}\$\s?([\d,.]+)/i))) { newTarget = toMoney(m[1]); }
  else if ((m = text.match(/\$\s?([\d,.]+)\s+(?:price\s+)?(?:target|PT)\b/i))) { newTarget = toMoney(m[1]); }

  let action;
  if (/upgrade/i.test(h)) action = "Upgrade";
  else if (/downgrade/i.test(h)) action = "Downgrade";
  else if (/initiat|coverage|starts? at/i.test(h)) action = "Initiate";
  else if (/(raise|boost|lift|hike|increase|bump)[a-z]*\b[^.]{0,40}(?:target|PT\b)/i.test(h)) action = "PT Raise";
  else if (/(cut|lower|trim|reduce|slash)[a-z]*\b[^.]{0,40}(?:target|PT\b)/i.test(h)) action = "PT Cut";
  else if (oldTarget != null && newTarget != null) action = newTarget > oldTarget ? "PT Raise" : newTarget < oldTarget ? "PT Cut" : "Reiterate";
  else action = "Reiterate";

  let firm = FIRMS.find((f) => new RegExp("\\b" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(h));
  if (!firm && (m = h.match(/^([A-Z][\w.&'\- ]{1,38}?)\s+(?:upgrades|downgrades|raises|cuts|lowers|boosts|lifts|trims|initiates|starts|reiterates|maintains|sees|says)\b/))) firm = m[1].trim();

  const toR = text.match(new RegExp("\\bto\\s+(?:an?\\s+)?" + RATING + "\\b", "i"));
  const fromR = text.match(new RegExp("\\bfrom\\s+(?:an?\\s+)?" + RATING + "\\b", "i"));
  const atR = text.match(new RegExp("\\b(?:with|at)\\s+(?:an?\\s+)?" + RATING + "\\b", "i"));
  const keepR = text.match(new RegExp("\\b(?:keeps?|maintains?|reiterates?|retains?)\\s+(?:an?\\s+)?" + RATING + "\\b", "i"));
  const toRating = (toR && toR[1]) || (atR && atR[1]) || (keepR && keepR[1]) || "—";
  const fromRating = (fromR && fromR[1]) || (action === "Upgrade" || action === "Downgrade" ? "—" : toRating);

  if (!firm && newTarget == null && action === "Reiterate") return null; // too vague to be useful
  return { firm: firm || "Analyst", action, fromRating, toRating, oldTarget, newTarget };
}

/**
 * Analyst feed from free sources, last `days`:
 *   - Finnhub company news filtered to analyst headlines → firm, action, PT shift, real article link
 *   - FMP analyst grades → firm + rating change (no price targets on free data)
 * Duplicates (same ticker + firm + day) keep the richer news version.
 */
const STOP = new Set(["the", "inc", "inc.", "corp", "corp.", "co", "co.", "company", "group", "holdings", "plc", "ltd", "sa", "nv"]);
/** Does this headline talk about `ticker` / its company (and not just a peer that appeared in its news feed)? */
function mentions(text, ticker, name) {
  const t = String(text || "");
  if (new RegExp("(^|[^A-Za-z])\\$?" + ticker.replace(".", "\\.") + "([^A-Za-z]|$)").test(t)) return true;
  const word = String(name || "").split(/[\s,]+/).find((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  return word ? new RegExp("\\b" + word.replace(/[^\w]/g, "") .slice(0, 12), "i").test(t) : true;
}

export async function buildLiveAnalystFeed(tickers, P, { days = 30, names = {} } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const items = [];

  if (P.finnhub && P.finnhub.news) {
    const lists = await mapLimit(tickers, 3, (t) => P.finnhub.news(t, since, today));
    lists.forEach((list, i) => {
      if (!Array.isArray(list)) return;
      const seen = new Set();
      list.forEach((n) => {
        if (!mentions(n.headline, tickers[i], names[tickers[i]])) return;
        const parsed = parseAnalystHeadline(n.headline, n.summary);
        if (!parsed) return;
        const key = n.headline.toLowerCase().slice(0, 80);
        if (seen.has(key)) return; seen.add(key);
        items.push({
          date: new Date((n.datetime || 0) * 1000).toISOString().slice(0, 10), ticker: tickers[i], ...parsed,
          headline: n.headline, rationale: (n.summary || "").replace(/\s+/g, " ").trim().slice(0, 220) || n.headline,
          source: n.source || "News", url: n.url || null, via: "Finnhub news",
        });
      });
    });
  }

  if (P.fmp) {
    const lists = await mapLimit(tickers, 3, (t) => P.fmp.grades(t));
    lists.forEach((list, i) => {
      if (!Array.isArray(list)) return;
      list.filter((g) => String(g.date).slice(0, 10) >= since).slice(0, 5).forEach((g) => {
        items.push({
          date: String(g.date).slice(0, 10), ticker: tickers[i], firm: g.gradingCompany || "—",
          action: ACTION_MAP[String(g.action || "").toLowerCase()] || "Reiterate",
          fromRating: g.previousGrade || "—", toRating: g.newGrade || "—", oldTarget: null, newTarget: null,
          rationale: "Rating " + (g.previousGrade ? g.previousGrade + " → " : "") + (g.newGrade || "updated") + ".",
          source: "Yahoo Finance", via: "FMP grades",
        });
      });
    });
  }

  // De-dupe: same ticker + firm (first word) + date → keep the one with targets / a real link.
  const norm = (f) => String(f).toLowerCase().replace(/[^a-z]/g, "").slice(0, 6);
  const best = new Map();
  for (const it of items) {
    const k = it.ticker + "|" + norm(it.firm) + "|" + it.date;
    const cur = best.get(k);
    const rich = (x) => (x.url ? 2 : 0) + (x.newTarget != null ? 1 : 0);
    if (!cur || rich(it) > rich(cur)) best.set(k, it);
  }
  return Array.from(best.values()).sort((a, b) => b.date.localeCompare(a.date));
}

/** Finnhub insider transactions (open-market P/S only, last `days`) → insider items. */
export async function buildLiveInsider(tickers, P, { days = 90 } = {}) {
  if (!P.finnhub) return [];
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const lists = await mapLimit(tickers, 3, (t) => P.finnhub.insider(t, since));
  const items = [];
  lists.forEach((list, i) => {
    if (!Array.isArray(list)) return;
    list.filter((x) => (x.transactionCode === "P" || x.transactionCode === "S") && x.transactionPrice).forEach((x) => {
      const shares = Math.abs(x.change || 0);
      const value = Math.round(shares * x.transactionPrice) * (x.transactionCode === "P" ? 1 : -1);
      items.push({ date: String(x.filingDate || x.transactionDate).slice(0, 10), ticker: tickers[i], role: x.name || "Insider", shares, value, planned: false });
    });
  });
  return items.sort((a, b) => b.date.localeCompare(a.date));
}
