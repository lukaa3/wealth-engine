/**
 * universe.js — the list of stocks the daily job scans.
 *   S&P 500 (from the open "datasets/s-and-p-500-companies" CSV on GitHub)
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
export async function loadUniverse({ fetchImpl = fetch, extra = [], fallback = [] } = {}) {
  const out = new Map();
  try {
    const res = await fetchImpl(SP500_CSV);
    if (!res.ok) throw new Error("HTTP " + res.status);
    for (const r of parseCsv(await res.text())) {
      const t = (r.Symbol || "").toUpperCase();
      if (t) out.set(t, { ticker: t, name: r.Security || t, sector: mapSector(r["GICS Sector"]) });
    }
  } catch (e) {
    console.warn("S&P 500 list unavailable (" + e.message + "); using the built-in list only.");
  }
  for (const t of [...EXTRA_TICKERS, ...Object.keys(KNOWN), ...extra, ...fallback.map((f) => f.ticker || f)]) {
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
