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

async function getJSON(url, { cache, cacheKey, ttlMs, signal }) {
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
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
