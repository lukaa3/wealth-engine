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
   * Yahoo quoteSummary: analyst targets, ratings, P/E, growth and cash-flow data — free, no key (unofficial).
   * Needs a session cookie + "crumb", fetched once per run.
   */
  const YUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  let ySession = null;
  const yLogin = async () => {
    let cookie = "";
    for (const url of ["https://fc.yahoo.com", "https://finance.yahoo.com/quote/AAPL/"]) {
      try {
        const r = await fetch(url, { signal, redirect: "manual", headers: { "User-Agent": YUA } });
        const set = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
        cookie = set.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
        if (cookie) break;
      } catch { /* try next */ }
    }
    for (const host of ["query2", "query1"]) {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { signal, headers: { "User-Agent": YUA, Cookie: cookie } });
      const crumb = (await r.text()).trim();
      if (r.ok && crumb && crumb.length < 40 && !/[<{]/.test(crumb)) return { cookie, crumb };
    }
    throw new ProviderError("yahoo: couldn't get a session (crumb)");
  };
  const Y_MODULES = "financialData,defaultKeyStatistics,summaryDetail,recommendationTrend,earningsTrend,price";
  if (yahoo) yahoo.summary = async (t) => {
    const key = "y:s:" + t;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (!ySession) ySession = yLogin();
    let sess = await ySession;
    const wait = (opts.yahooGapMs ?? 350) - (Date.now() - yLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    yLast = Date.now();
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(dash(t))}?modules=${Y_MODULES}&crumb=${encodeURIComponent(sess.crumb)}`, {
        signal, headers: { "User-Agent": YUA, Cookie: sess.cookie, Accept: "application/json" },
      });
      if (res.status === 401 && attempt === 0) { ySession = yLogin(); sess = await ySession; continue; }
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
    if (!res.ok) throw new ProviderError("yahoo summary HTTP " + res.status);
    const j = await res.json();
    const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
    if (!r) throw new ProviderError("yahoo summary: no data");
    const out = parseYahooSummary(r);
    cache.set(key, out, fTtl);
    return out;
  };

  return { fmp, finnhub, alpha, yahoo, cache, num };
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

/** Yahoo quoteSummary → the flat fields the screener uses. Values arrive as {raw, fmt}. */
export function parseYahooSummary(r) {
  const v = (o, k) => { const x = o && o[k]; const n = x && typeof x === "object" ? x.raw : x; return typeof n === "number" && isFinite(n) ? n : null; };
  const fd = r.financialData || {}, ks = r.defaultKeyStatistics || {}, sd = r.summaryDetail || {}, pr = r.price || {};
  const trend = ((r.recommendationTrend && r.recommendationTrend.trend) || []).find((x) => x.period === "0m") || null;
  const et = (r.earningsTrend && r.earningsTrend.trend) || [];
  const grow = (p) => { const x = et.find((e) => e.period === p); return x ? v(x, "growth") : null; };
  return {
    name: pr.longName || pr.shortName || null,
    price: v(fd, "currentPrice") ?? v(pr, "regularMarketPrice"),
    targetMean: v(fd, "targetMeanPrice"), targetMedian: v(fd, "targetMedianPrice"),
    targetHigh: v(fd, "targetHighPrice"), targetLow: v(fd, "targetLowPrice"),
    analystOpinions: v(fd, "numberOfAnalystOpinions"), recMean: v(fd, "recommendationMean"),
    counts: trend ? { strongBuy: trend.strongBuy || 0, buy: trend.buy || 0, hold: trend.hold || 0, sell: trend.sell || 0, strongSell: trend.strongSell || 0 } : null,
    forwardPE: v(sd, "forwardPE") ?? v(ks, "forwardPE"), trailingPE: v(sd, "trailingPE"),
    peg: v(ks, "pegRatio"), beta: v(sd, "beta") ?? v(ks, "beta"),
    growthNextYear: grow("+1y"), growthThisYear: grow("0y"), growth5y: grow("+5y"),
    revenueGrowth: v(fd, "revenueGrowth"), earningsGrowth: v(fd, "earningsGrowth"),
    freeCashflow: v(fd, "freeCashflow"), totalCash: v(fd, "totalCash"), totalDebt: v(fd, "totalDebt"),
    shares: v(ks, "sharesOutstanding") ?? v(pr, "sharesOutstanding") ?? (v(pr, "marketCap") && v(fd, "currentPrice") ? v(pr, "marketCap") / v(fd, "currentPrice") : null),
  };
}

/**
 * Simple two-stage DCF from Yahoo's numbers: free cash flow grows at g for 5 years, fades to 3% by year 10,
 * discounted at 9%, 3% terminal growth; net cash added. g = average of next-year EPS growth and revenue growth, capped 0–20%.
 * Returns null when free cash flow is negative or data is missing (a DCF means nothing there).
 */
export function yahooDcf(y) {
  if (!y || !(y.freeCashflow > 0) || !(y.shares > 0)) return null;
  const gs = [y.growth5y, y.growthNextYear, y.revenueGrowth].filter((x) => x != null && isFinite(x));
  if (!gs.length) return null;
  const g = Math.min(0.2, Math.max(0, gs.reduce((a, b) => a + b, 0) / gs.length));
  const r = 0.09, tg = 0.03;
  let fcf = y.freeCashflow, pv = 0;
  for (let yr = 1; yr <= 10; yr++) {
    const gy = yr <= 5 ? g : g + ((tg - g) * (yr - 5)) / 5;
    fcf *= 1 + gy;
    pv += fcf / Math.pow(1 + r, yr);
  }
  pv += (fcf * (1 + tg)) / (r - tg) / Math.pow(1 + r, 10);
  const equity = pv + (y.totalCash || 0) - (y.totalDebt || 0);
  return equity > 0 ? Math.round((equity / y.shares) * 100) / 100 : null;
}

/** PEG: Yahoo's own if present, else forward P/E ÷ next-year EPS growth (in %). Null when growth ≤ 0. */
export function yahooPeg(y) {
  if (!y) return null;
  if (y.peg != null && y.peg > 0) return Math.round(y.peg * 100) / 100;
  const g = y.growth5y ?? y.growthNextYear ?? y.earningsGrowth;
  if (!(y.forwardPE > 0) || !(g > 0)) return null;
  return Math.round((y.forwardPE / (g * 100)) * 100) / 100;
}
