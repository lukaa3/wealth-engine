/**
 * providers.js — thin fetch() clients for free-tier market-data APIs. Works in the browser and in Node 18+.
 *   Financial Modeling Prep  https://financialmodelingprep.com/stable/...   (quote, profile, DCF, price-target consensus,
 *                                                                           grades + grades consensus, ratios TTM, daily candles)
 *   Finnhub                  https://finnhub.io/api/v1/...                  (quote, recommendation trends, company news, insider transactions)
 *   Alpha Vantage            https://www.alphavantage.co/query?function=... (OVERVIEW: PEG, forward P/E, targets, ratings; daily candles)
 * Free plans differ in what they include, so every call can fail (403 / plan limit / rate limit). Callers treat
 * a failure as "field unavailable" rather than an error. Results are cached with a TTL to save quota.
 */

const FMP = "https://financialmodelingprep.com/stable";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const FINNHUB = "https://finnhub.io/api/v1";
const AV = "https://www.alphavantage.co/query";

/** Cache adapter: localStorage in the browser, a Map in Node (or pass your own). */
export function createCache(prefix = "wse-cache:") {
  const mem = new Map();
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  return {
    get(key) {
      try {
        const raw = ls ? ls.getItem(prefix + key) : mem.get(key);
        if (!raw) return undefined;
        const { t, ttl, v } = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Date.now() - t < ttl ? v : undefined;
      } catch (e) { return undefined; }
    },
    set(key, v, ttl) {
      const rec = { t: Date.now(), ttl, v };
      try { ls ? ls.setItem(prefix + key, JSON.stringify(rec)) : mem.set(key, rec); } catch (e) { mem.set(key, rec); }
    },
    clear() {
      mem.clear();
      if (!ls) return;
      try { Object.keys(ls).filter((k) => k.startsWith(prefix)).forEach((k) => ls.removeItem(k)); } catch (e) {}
    },
  };
}

class ProviderError extends Error {}

// Finnhub's free plan allows 60 calls/minute — space calls out so a bigger deep check doesn't trip it.
let fhNext = 0;
const FH_GAP_MS = typeof process !== "undefined" && process.env && process.env.FH_GAP_MS ? Number(process.env.FH_GAP_MS) : 1050;
async function paceFinnhub() {
  const now = Date.now(), at = Math.max(now, fhNext);
  fhNext = at + FH_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function getJSON(url, { cache, cacheKey, ttlMs, signal }) {
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const isFh = url.startsWith(FINNHUB);
  let res;
  for (let attempt = 0; attempt < (isFh ? 3 : 1); attempt++) {
    if (isFh) await paceFinnhub();
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (res.status !== 429 || !isFh) break;
    await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
  }
  if (res.status === 429) throw new ProviderError("rate limited");
  if (!res.ok) {
    let detail = "";
    try { const t = await res.text(); const j = JSON.parse(t); detail = j["Error Message"] || j.error || j.message || t; } catch (e) {}
    throw new ProviderError("HTTP " + res.status + (detail ? " " + String(detail).replace(/\s+/g, " ").slice(0, 110) : ""));
  }
  const data = await res.json();
  // Vendors report plan/limit problems inside 200 responses:
  if (data && !Array.isArray(data) && typeof data === "object") {
    const msg = data["Error Message"] || data.error || data.Note || data.Information;
    if (msg) throw new ProviderError(String(msg).slice(0, 140));
  }
  if (cache && cacheKey) cache.set(cacheKey, data, ttlMs);
  return data;
}

const first = (x) => (Array.isArray(x) ? x[0] : x) || null;
const num = (v) => (v == null || v === "" || v === "None" || v === "-" || isNaN(Number(v)) ? null : Number(v));

/**
 * keys: { fmpKey, finnhubKey, alphaVantageKey }
 * opts: { cache, quoteTtlMin, fundamentalsTtlHours, signal }
 */
export function createProviders(keys, opts = {}) {
  const cache = opts.cache || createCache();
  const qTtl = (opts.quoteTtlMin ?? 5) * 60e3;
  const fTtl = (opts.fundamentalsTtlHours ?? 24) * 3600e3;
  const signal = opts.signal;
  const o = (key, ttlMs) => ({ cache, cacheKey: key, ttlMs, signal });

  const dash = (t) => t.replace(".", "-"); // FMP and Yahoo write BRK.B as BRK-B

  const fmp = keys.fmpKey && {
    quote: async (t) => first(await getJSON(`${FMP}/quote?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:q:" + t, qTtl))),
    profile: async (t) => first(await getJSON(`${FMP}/profile?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:p:" + t, fTtl * 7))),
    dcf: async (t) => first(await getJSON(`${FMP}/discounted-cash-flow?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:dcf:" + t, fTtl))),
    priceTarget: async (t) => first(await getJSON(`${FMP}/price-target-consensus?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:pt:" + t, fTtl))),
    gradesConsensus: async (t) => first(await getJSON(`${FMP}/grades-consensus?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:gc:" + t, fTtl))),
    grades: async (t) => (await getJSON(`${FMP}/grades?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:g:" + t, fTtl / 2))) || [],
    ratiosTtm: async (t) => first(await getJSON(`${FMP}/ratios-ttm?symbol=${dash(t)}&apikey=${keys.fmpKey}`, o("fmp:r:" + t, fTtl))),
    daily: async (t) => {
      const from = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
      const d = await getJSON(`${FMP}/historical-price-eod/full?symbol=${dash(t)}&from=${from}&apikey=${keys.fmpKey}`, o("fmp:d:" + t, fTtl / 2));
      const rows = Array.isArray(d) ? d : d && d.historical ? d.historical : [];
      return rows.map((r) => ({ date: r.date, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume || 0 }))
        .sort((a, b) => a.date.localeCompare(b.date));
    },
  };

  const finnhub = keys.finnhubKey && {
    quote: async (t) => {
      const q = await getJSON(`${FINNHUB}/quote?symbol=${dash(t)}&token=${keys.finnhubKey}`, o("fh:q:" + t, qTtl));
      return q && q.c ? { price: q.c, changePct: q.dp } : null;
    },
    recommendation: async (t) => first(await getJSON(`${FINNHUB}/stock/recommendation?symbol=${t}&token=${keys.finnhubKey}`, o("fh:rec:" + t, fTtl))),
    metric: async (t) => {
      const m = await getJSON(`${FINNHUB}/stock/metric?symbol=${t}&metric=all&token=${keys.finnhubKey}`, o("fh:m:" + t, fTtl));
      return (m && m.metric) || null;
    },
    /** Company news (headline, summary, source, url). Used to find analyst actions with real article links. */
    news: async (t, fromDate, toDate) =>
      (await getJSON(`${FINNHUB}/company-news?symbol=${t}&from=${fromDate}&to=${toDate}&token=${keys.finnhubKey}`, o("fh:news:" + t + ":" + fromDate, 3 * 3600e3))) || [],
    insider: async (t, fromDate) => {
      const d = await getJSON(`${FINNHUB}/stock/insider-transactions?symbol=${t}&from=${fromDate}&token=${keys.finnhubKey}`, o("fh:ins:" + t, fTtl / 2));
      return (d && d.data) || [];
    },
    /** Upcoming earnings for ALL companies in a date range (one call): { TICKER: "YYYY-MM-DD" }. */
    earningsCalendar: async (fromDate, toDate) => {
      const d = await getJSON(`${FINNHUB}/calendar/earnings?from=${fromDate}&to=${toDate}&token=${keys.finnhubKey}`, o("fh:ecal:" + fromDate + ":" + toDate, 6 * 3600e3));
      const out = {};
      ((d && d.earningsCalendar) || []).forEach((e) => { if (e.symbol && e.date && (!out[e.symbol] || e.date < out[e.symbol])) out[e.symbol.replace("-", ".")] = e.date; });
      return out;
    },
  };

  // Alpha Vantage free = 25 calls/day: cap calls per run and stop once it reports a limit.
  const avCache = opts.avCache || cache;
  const av = { budget: opts.avMaxCalls ?? 20, used: 0, exhausted: false };
  const gap = opts.avMinGapMs ?? 1500; // spacing between live calls (per-minute limit)
  let chain = Promise.resolve();
  const avGet = async (url, key, ttl) => {
    const hit = avCache.get(key);
    if (hit !== undefined) return hit;
    if (av.exhausted || av.used >= av.budget) throw new ProviderError("Alpha Vantage daily budget used");
    av.used++;
    const turn = chain.then(() => new Promise((r) => setTimeout(r, av.used > 1 ? gap : 0)));
    chain = turn;
    await turn;
    try { return await getJSON(url, { cache: avCache, cacheKey: key, ttlMs: ttl, signal }); }
    catch (e) { if (/rate limit|requests per day|premium|frequency|25 requests/i.test(e.message)) av.exhausted = true; throw e; }
  };
  const alpha = keys.alphaVantageKey && {
    stats: av,
    overview: async (t) => {
      const d = await avGet(`${AV}?function=OVERVIEW&symbol=${t}&apikey=${keys.alphaVantageKey}`, "av:o:" + t, fTtl * 3);
      return d && d.Symbol ? d : null;
    },
    daily: async (t) => {
      const d = await avGet(`${AV}?function=TIME_SERIES_DAILY&symbol=${t}&outputsize=compact&apikey=${keys.alphaVantageKey}`, "av:d:" + t, fTtl / 2);
      const s = (d && d["Time Series (Daily)"]) || {};
      return Object.entries(s).map(([date, r]) => ({ date, open: +r["1. open"], high: +r["2. high"], low: +r["3. low"], close: +r["4. close"] }))
        .sort((a, b) => a.date.localeCompare(b.date));
    },
  };

  /**
   * Yahoo Finance chart feed: daily candles with no key (unofficial; can change or throttle without notice).
   * Used by the daily job's wide market scan. Only enabled when opts.yahoo is true (Node), since browsers block it (CORS).
   */
  let yLast = 0;
  const yahoo = opts.yahoo && {
    daily: async (t) => {
      const key = "y:d:" + t;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const wait = (opts.yahooGapMs ?? 350) - (Date.now() - yLast);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      yLast = Date.now();
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(`${YAHOO}/${encodeURIComponent(dash(t))}?range=1y&interval=1d`, {
          signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; wealth-engine-screener/1.0)", Accept: "application/json" },
        });
        if (res.status !== 429) break;
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
      if (!res.ok) throw new ProviderError("yahoo HTTP " + res.status);
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new ProviderError("yahoo: no data");
      const q = r.indicators.quote[0];
      const rows = [];
      r.timestamp.forEach((ts, i) => {
        if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) return;
        rows.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
      });
      const out = { candles: rows, price: r.meta && r.meta.regularMarketPrice, name: r.meta && (r.meta.longName || r.meta.shortName) };
      cache.set(key, out, fTtl / 2);
      return out;
    },
  };

  /**
   * Nasdaq.com data API: analyst price targets + buy/hold/sell counts, forward PEG and P/E (Zacks consensus),
   * market cap, and annual financial statements — free, no key (unofficial; Node only, browsers are blocked by CORS).
   */
  let nqLast = 0;
  const NQ_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
  const nqGet = async (path, key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const wait = (opts.nasdaqGapMs ?? 250) - (Date.now() - nqLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nqLast = Date.now();
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch("https://api.nasdaq.com/api/" + path, { signal, headers: NQ_HEADERS });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    if (!res.ok) throw new ProviderError("nasdaq HTTP " + res.status);
    const j = await res.json();
    const data = j && j.data ? j.data : null; // null = "No record found" (ETFs, funds, new listings)
    cache.set(key, data, fTtl);
    return data;
  };
  const nasdaq = opts.nasdaq && {
    /** → flat fields (see parseNasdaq); null when Nasdaq has nothing for the ticker. */
    fundamentals: async (t) => {
      const ck = "nq:f2:" + t;
      const hit = cache.get(ck);
      if (hit !== undefined) return hit;
      const s = encodeURIComponent(dash(t));
      const soft = (p) => p.catch(() => null); // one missing page shouldn't sink the rest
      const [tp, peg, sum, fin, fc, em, es] = await Promise.all([
        soft(nqGet(`analyst/${s}/targetprice`, "nqraw:tp:" + t)),
        soft(nqGet(`analyst/${s}/peg-ratio`, "nqraw:peg:" + t)),
        soft(nqGet(`quote/${s}/summary?assetclass=stocks`, "nqraw:sum:" + t)),
        soft(nqGet(`company/${s}/financials?frequency=1`, "nqraw:fin:" + t)),
        soft(nqGet(`analyst/${s}/earnings-forecast`, "nqraw:fc:" + t)),
        soft(nqGet(`analyst/${s}/estimate-momentum`, "nqraw:em:" + t)),
        soft(nqGet(`company/${s}/earnings-surprise`, "nqraw:es:" + t)),
      ]);
      if (!tp && !peg && !sum && !fin && !fc) throw new ProviderError("nasdaq: no data (all pages failed or empty)");
      const out = parseNasdaq({ tp, peg, sum, fin, fc, em, es });
      cache.set(ck, out, fTtl);
      return out;
    },
  };

  return { fmp, finnhub, alpha, yahoo, nasdaq, cache, num };
}

/** Run `fn` over items with limited concurrency; never throws, collects errors. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** "$1,234,000" / "-$5" / "12.5%" / "--" → number (null when not a number). */
export function nqNum(x) {
  if (x == null) return null;
  if (typeof x === "number") return isFinite(x) ? x : null;
  const t = String(x).replace(/[$,%\s]/g, "");
  if (!t || t === "--" || /n\/?a/i.test(t)) return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
}

/**
 * Nasdaq responses → flat fields: price target + buy/hold/sell counts, PEG, forward P/E, market cap, cash flow,
 * plus earnings momentum (EPS estimate raises vs cuts in the last 4 weeks, 1-month consensus change, expected EPS growth,
 * last 4 quarterly surprises) and quality (margins, return on equity).
 */
export function parseNasdaq({ tp, peg, sum, fin, fc, em, es }) {
  const co = tp && tp.consensusOverview;
  const counts = co && (co.buy || co.hold || co.sell) ? { strongBuy: 0, buy: co.buy || 0, hold: co.hold || 0, sell: co.sell || 0, strongSell: 0 } : null;
  const pegV = peg && peg.pegr ? nqNum(peg.pegr.pegValue) : null;
  const perRows = (peg && peg.per && (peg.per.peRatioChart || peg.per)) || [];
  const fwd = Array.isArray(perRows) ? perRows.find((r) => /estimate/i.test(r.x)) : null;
  const gRows = ((peg && peg.gr && peg.gr.peGrowthChart) || []).filter((r) => r.z === "Growth").map((r) => nqNum(r.y)).filter((x) => x != null);
  const sd = (sum && sum.summaryData) || {};
  // Statements are in thousands of dollars; value2 = latest fiscal year, value3 = the year before.
  const row = (table, label, col = "value2") => {
    const r = ((fin && fin[table] && fin[table].rows) || []).find((x) => x.value1 === label);
    return r ? nqNum(r[col]) : null;
  };
  const k = (x) => (x == null ? null : x * 1000);
  const ocf = row("cashFlowTable", "Net Cash Flow-Operating"), capex = row("cashFlowTable", "Capital Expenditures");
  const rev = row("incomeStatementTable", "Total Revenue"), revPrev = row("incomeStatementTable", "Total Revenue", "value3");
  // Earnings estimates: yearly rows = current fiscal year, next, …
  const yr = (fc && fc.yearlyForecast && fc.yearlyForecast.rows) || [];
  const eps0 = yr[0] ? nqNum(yr[0].consensusEPSForecast) : null, eps1 = yr[1] ? nqNum(yr[1].consensusEPSForecast) : null;
  const revUp = yr.slice(0, 2).reduce((a, r) => a + (nqNum(r.up) || 0), 0), revDown = yr.slice(0, 2).reduce((a, r) => a + (nqNum(r.down) || 0), 0);
  const cc = em && em.changeInConsensus;
  const yrNow = cc && cc.currentData ? nqNum(cc.currentData.yrMean) : null, yrMonth = cc && cc.monthData ? nqNum(cc.monthData.yrMean) : null;
  const surprises = ((es && es.earningsSurpriseTable && es.earningsSurpriseTable.rows) || []).slice(0, 4)
    .map((r) => nqNum(r.percentageSurprise)).filter((x) => x != null).map((x) => x / 100);
  const ratio = (label) => { const r = row("financialRatiosTable", label); return r == null ? null : r / 100; };
  return {
    epsThisYear: eps0, epsNextYear: eps1,
    epsGrowthNext: eps0 != null && eps1 != null && eps0 > 0 ? eps1 / eps0 - 1 : null,
    turningProfitable: eps0 != null && eps1 != null && eps0 <= 0 && eps1 > eps0,
    revUp: fc ? revUp : null, revDown: fc ? revDown : null,
    consensusChange1m: yrNow != null && yrMonth ? (yrNow - yrMonth) / Math.abs(yrMonth) : null,
    surprises: surprises.length ? surprises : null,
    grossMargin: ratio("Gross Margin"), opMargin: ratio("Operating Margin"), profitMargin: ratio("Profit Margin"), roe: ratio("After Tax ROE"),
    target: co ? nqNum(co.priceTarget) : nqNum(sd.OneYrTarget && sd.OneYrTarget.value),
    targetLow: co ? nqNum(co.lowPriceTarget) : null, targetHigh: co ? nqNum(co.highPriceTarget) : null,
    counts,
    peg: pegV && pegV > 0 ? pegV : null,
    forwardPE: fwd ? nqNum(fwd.y) : null,          // negative = expected loss
    growth: gRows.length ? gRows[gRows.length > 1 ? 1 : 0] / 100 : null, // next fiscal year's EPS growth
    revenueGrowth: rev && revPrev ? rev / revPrev - 1 : null,
    marketCap: nqNum(sd.MarketCap && sd.MarketCap.value),
    sector: (sd.Sector && sd.Sector.value) || null,
    fcf: ocf != null ? k(ocf + (capex || 0)) : null, // capex is reported negative
    cash: k((row("balanceSheetTable", "Cash and Cash Equivalents") || 0) + (row("balanceSheetTable", "Short-Term Investments") || 0)),
    debt: k((row("balanceSheetTable", "Long-Term Debt") || 0) + (row("balanceSheetTable", "Short-Term Debt / Current Portion of Long-Term Debt") || 0)),
  };
}

/**
 * Simple two-stage DCF: free cash flow grows at g for 5 years, fades to 3% by year 10, discounted at 9%,
 * 3% terminal growth, plus net cash. g = average of next-year EPS growth and last year's revenue growth, capped 0–20%.
 * → { value } per share, { negative: true } when free cash flow is negative (no DCF support), or null if data is missing.
 */
export function simpleDcf({ fcf, shares, cash, debt, growth, revenueGrowth }) {
  if (fcf == null || !(shares > 0)) return null;
  if (fcf <= 0) return { negative: true };
  const gs = [growth, revenueGrowth].filter((x) => x != null && isFinite(x));
  const g = gs.length ? Math.min(0.2, Math.max(0, gs.reduce((a, b) => a + b, 0) / gs.length)) : 0.03;
  const r = 0.09, tg = 0.03;
  let f = fcf, pv = 0;
  for (let yr = 1; yr <= 10; yr++) {
    f *= 1 + (yr <= 5 ? g : g + ((tg - g) * (yr - 5)) / 5);
    pv += f / Math.pow(1 + r, yr);
  }
  pv += (f * (1 + tg)) / (r - tg) / Math.pow(1 + r, 10);
  const equity = pv + (cash || 0) - (debt || 0);
  return equity > 0 ? { value: Math.round((equity / shares) * 100) / 100 } : { negative: true };
}
