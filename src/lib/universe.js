/**
 * universe.js — the list of stocks the daily job scans.
 *   Every US-listed common stock worth $2B+ and priced $5+ (Nasdaq's free screener list, ~1,500–2,000 names)
 *   + S&P 500 (from the open "datasets/s-and-p-500-companies" CSV on GitHub, in case the Nasdaq list fails)
 *   + Nasdaq-100 names outside the S&P 500 + popular high-momentum names
 *   + anything in WATCHLIST / EXTRA_TICKERS.
 * Tickers use the dot form (BRK.B); providers convert as needed.
 */
import { mapSector } from "./liveData.js";

export const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// Nasdaq-100 members that aren't in the S&P 500, plus widely traded momentum names. Edit freely.
export const EXTRA_TICKERS = [
  "ASML", "AZN", "PDD", "MELI", "ARM", "CCEP", "TEAM", "MRVL", "MDB", "ZS", "GFS", "SHOP", "TTD", "APP", "MSTR",
  "SOFI", "RKLB", "IONQ", "SMCI", "HOOD", "COIN", "PLTR", "CRWD", "NET", "SNOW", "DDOG", "U", "RBLX", "AFRM", "UPST",
  "CELH", "ONON", "DKNG", "CVNA", "TSM", "NU", "SE", "SPOT", "UBER", "ABNB", "DASH", "AXON", "VRT", "ANET", "CEG",
  "VST", "OKLO", "SMR", "HIMS", "ALAB", "CRDO", "NBIS", "TEM", "RDDT", "DUOL", "CAVA", "ELF", "TOST", "SOUN", "ACHR",
];

/** Stocks Yur owns: always get the full daily check so the Portfolio tab can say buy more / hold / trim / sell. */
export const HOLDINGS = ["MSFT", "PLTR", "HOOD", "META", "SPCX", "JPM", "AAL", "NOW", "NVDA", "QCOM", "NFLX", "BE", "ONDS", "IREN"];

/**
 * Tickers Yur owns that aren't in the S&P 500 list, plus sector fixes for ones that land in the wrong bucket.
 * [sector, name, fund?] — funds/ETFs are priced every day but never treated as picks.
 */
export const KNOWN = {
  RVII: ["Technology", "Robinhood Ventures Fund II", true],
  SPY: ["Index Funds", "SPDR S&P 500 ETF", true],
  QQQ: ["Index Funds", "Invesco QQQ (Nasdaq-100)", true],
  IWM: ["Index Funds", "iShares Russell 2000 ETF", true],
  XLV: ["Healthcare", "Health Care Select Sector SPDR ETF", true],
  VFH: ["Financials", "Vanguard Financials ETF", true],
  VDC: ["Consumer", "Vanguard Consumer Staples ETF", true],
  XLY: ["Consumer", "Consumer Discretionary Select Sector SPDR ETF", true],
  XLU: ["Other", "Utilities Select Sector SPDR ETF", true],
  SPCX: ["Technology", "SpaceX"],
  ONDS: ["Technology", "Ondas Inc."],
  IREN: ["Technology", "IREN Limited"],
  AAL: ["Other", "American Airlines"],
  BE: ["Energy", "Bloom Energy"],
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(",").map((h) => h.replace(/"/g, "").trim());
  return lines.map((line) => {
    const cells = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] || "").trim()]));
  });
}

/** Returns [{ ticker, name, sector }] — never throws; falls back to the extras + fallback list. */
const NASDAQ_SCREENER = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true";
const NQ_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
const NQ_SECTOR = { Technology: "Technology", Telecommunications: "Technology", Finance: "Financials", "Health Care": "Healthcare",
  "Consumer Discretionary": "Consumer", "Consumer Staples": "Consumer", Energy: "Energy" };
// Not common stock: warrants, rights, units, preferreds, notes, and fund-like listings.
const NOT_COMMON = /warrant|\bright(s)?\b|\bunits?\b|preferred|depositary shares? representing|% notes|notes due|debentures|\btrust\b.*\bunits?\b|closed[- ]end|\bETF\b|\bfund\b/i;

/** Every US-listed common stock above a size and price floor, from Nasdaq's free screener (NYSE, Nasdaq, AMEX). */
export async function loadListedStocks({ fetchImpl = fetch, minCap = 2e9, minPrice = 5 } = {}) {
  const res = await fetchImpl(NASDAQ_SCREENER, { headers: NQ_HEADERS });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const rows = (j && j.data && (j.data.rows || (j.data.table && j.data.table.rows))) || [];
  const out = [];
  for (const r of rows) {
    const sym = String(r.symbol || "").trim().toUpperCase().replace("/", ".");
    const cap = Number(String(r.marketCap || "").replace(/[$,]/g, "")) || 0;
    const price = Number(String(r.lastsale || "").replace(/[$,]/g, "")) || 0;
    if (!sym || /[\^ ]/.test(sym) || cap < minCap || price < minPrice || NOT_COMMON.test(r.name || "")) continue;
    out.push({ ticker: sym, name: String(r.name || sym).replace(/\s+(Common Stock|Class [A-Z] (Common|Ordinary) (Stock|Shares)|Ordinary Shares|American Depositary Shares)\b.*$/i, "").trim() || sym,
      sector: NQ_SECTOR[r.sector] || "Other", marketCap: cap });
  }
  return out;
}

export async function loadUniverse({ fetchImpl = fetch, extra = [], fallback = [], extras = true, broad = false } = {}) {
  const out = new Map();
  if (broad) {
    try {
      const listed = await loadListedStocks({ fetchImpl });
      listed.forEach((u) => out.set(u.ticker, u));
      console.log(`Nasdaq list: ${listed.length} US stocks worth $2B+ and priced $5+`);
    } catch (e) {
      console.warn("Nasdaq stock list unavailable (" + e.message + "); scanning the S&P 500 + extras only.");
    }
  }
  try {
    const res = await fetchImpl(SP500_CSV);
    if (!res.ok) throw new Error("HTTP " + res.status);
    for (const r of parseCsv(await res.text())) {
      const t = (r.Symbol || "").toUpperCase();
      // S&P's sector labels are better than Nasdaq's, so they win when a stock is on both lists.
      if (t) out.set(t, { ...(out.get(t) || {}), ticker: t, name: r.Security || t, sector: mapSector(r["GICS Sector"]) });
    }
  } catch (e) {
    console.warn("S&P 500 list unavailable (" + e.message + "); using the built-in list only.");
  }
  for (const t of [...(extras ? [...EXTRA_TICKERS, ...Object.keys(KNOWN)] : ["SPY"]), ...extra, ...fallback.map((f) => f.ticker || f)]) {
    const k = String(t).trim().toUpperCase();
    if (k && !out.has(k)) {
      const fb = fallback.find((f) => f.ticker === k);
      out.set(k, { ticker: k, name: fb ? fb.name : k, sector: fb ? fb.sector : "Other" });
    }
  }
  for (const [t, [sector, name, fund]] of Object.entries(KNOWN)) {
    const u = out.get(t);
    if (!u) continue;
    u.sector = sector;
    if (u.name === t) u.name = name;
    if (fund) u.fund = true;
  }
  return Array.from(out.values());
}
