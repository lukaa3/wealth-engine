/**
 * api.js — data layer for a static GitHub Pages front-end.
 *
 * Resolution order for every dataset (first one that returns data wins):
 *   1. Supabase        — rows pre-computed by the GitHub Action (scripts/update-screener.mjs)
 *   2. Static JSON     — ./data/*.json written by the same Action and deployed with the site
 *   3. Browser live    — direct fetch() to FMP / Finnhub / Alpha Vantage with the visitor's keys
 *   4. mockData.js     — always available, so the dashboard is fully populated out of the box
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { mockData } from "./mockData.js";
import { hasSupabaseData, hasVendorKeys, SYNC_CONFIG, parseWatchlist, loadSettings, saveSettings } from "./config.js";
import { createProviders, createCache } from "./lib/providers.js";
import { buildLiveUniverse, buildLiveAnalystFeed, buildLiveInsider } from "./lib/liveData.js";
import { rowToStock, rowToAction, rowToInsider } from "./lib/schema.js";
import { createSyncClient, newSyncCode, normalizeSyncCode } from "./lib/sync.js";

export const TABLES = { screener: "screener_metrics", analyst: "analyst_actions", insider: "insider_transactions" };
const SAMPLE_TICKERS = mockData.stocks.map((s) => s.ticker);
const BASE_BY_TICKER = Object.fromEntries(mockData.stocks.map((s) => [s.ticker, s]));
const NAMES = Object.fromEntries(mockData.stocks.map((s) => [s.ticker, s.name]));
const sharedCache = createCache();

/* ------------------------------- Low-level clients ------------------------------- */
async function supabaseSelect(settings, table, query, signal) {
  const url = `${settings.supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { signal, headers: { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${settings.supabaseAnonKey}` } });
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
  return res.json();
}

async function staticJson(settings, file, signal) {
  const res = await fetch(`${settings.staticJsonUrl.replace(/\/$/, "")}/${file}`, { signal, cache: "no-cache" });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

const providersFor = (settings, signal) =>
  createProviders(settings, { cache: sharedCache, quoteTtlMin: settings.quoteTtlMin, fundamentalsTtlHours: settings.fundamentalsTtlHours, signal });

export const clearLiveCache = () => sharedCache.clear();

/* ------------------------------------ Fetchers ------------------------------------ */
/** Screener universe: stocks in the same shape as mockData.stocks. */
export async function fetchLatestScreenerData(settings, { signal, onProgress } = {}) {
  const notes = [];
  if (settings.mode !== "mock") {
    if (hasSupabaseData(settings)) {
      try {
        const rows = await supabaseSelect(settings, TABLES.screener, "select=*&order=ticker.asc", signal);
        if (rows.length) return { stocks: rows.map(rowToStock), sectorPE: mockData.sectorPE, asOf: rows[0].updated_at?.slice(0, 10), source: "supabase", notes };
        notes.push("Supabase screener table is empty");
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
    try {
      const j = await staticJson(settings, "screener.json", signal);
      if (j && j.stocks && j.stocks.length) return { stocks: j.stocks.map(rowToStock), sectorPE: mockData.sectorPE, asOf: (j.generatedAt || "").slice(0, 10), source: "static-json", notes };
    } catch (e) { if (e.name === "AbortError") throw e; /* no static file deployed yet: normal */ }
    if (hasVendorKeys(settings)) {
      try {
        const tickers = parseWatchlist(settings, SAMPLE_TICKERS);
        const { stocks, failed } = await buildLiveUniverse(tickers, providersFor(settings, signal), BASE_BY_TICKER, onProgress);
        if (failed.length) notes.push(`No live quote for ${failed.length} ticker(s): ${failed.slice(0, 4).join(", ")}${failed.length > 4 ? "…" : ""}`);
        if (stocks.length) return { stocks, sectorPE: mockData.sectorPE, asOf: new Date().toISOString().slice(0, 10), source: "live", notes };
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
  }
  return { stocks: mockData.stocks, sectorPE: mockData.sectorPE, asOf: mockData.asOf, source: "mock", notes };
}

/** Analyst rating changes, newest first. */
export async function fetchAnalystFeed(settings, { signal, tickers } = {}) {
  const notes = [];
  if (settings.mode !== "mock") {
    if (hasSupabaseData(settings)) {
      try {
        const rows = await supabaseSelect(settings, TABLES.analyst, "select=*&order=action_date.desc&limit=100", signal);
        if (rows.length) return { items: rows.map(rowToAction), source: "supabase", notes };
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
    try {
      const j = await staticJson(settings, "analyst.json", signal);
      if (j && j.items && j.items.length) return { items: j.items.map(rowToAction), source: "static-json", notes };
    } catch (e) { if (e.name === "AbortError") throw e; }
    if (settings.fmpKey || settings.finnhubKey) {
      try {
        const items = await buildLiveAnalystFeed(tickers || parseWatchlist(settings, SAMPLE_TICKERS), providersFor(settings, signal), { names: NAMES });
        if (items.length) return { items, source: "live", notes };
        notes.push("No analyst headlines or grades found for this watchlist in the last 30 days");
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
  }
  return { items: mockData.analystFeed, source: "mock", notes };
}

/** Insider Form 4 transactions, trailing 90 days. */
export async function fetchInsiderActivity(settings, { signal, tickers } = {}) {
  const notes = [];
  if (settings.mode !== "mock") {
    if (hasSupabaseData(settings)) {
      try {
        const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
        const rows = await supabaseSelect(settings, TABLES.insider, `select=*&filing_date=gte.${since}&order=filing_date.desc`, signal);
        if (rows.length) return { items: rows.map(rowToInsider), source: "supabase", notes };
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
    try {
      const j = await staticJson(settings, "insider.json", signal);
      if (j && j.items && j.items.length) return { items: j.items.map(rowToInsider), source: "static-json", notes };
    } catch (e) { if (e.name === "AbortError") throw e; }
    if (settings.finnhubKey) {
      try {
        const items = await buildLiveInsider(tickers || parseWatchlist(settings, SAMPLE_TICKERS), providersFor(settings, signal));
        if (items.length) return { items, source: "live", notes };
        notes.push("Finnhub returned no insider trades (this endpoint may need a paid plan)");
      } catch (e) { if (e.name === "AbortError") throw e; notes.push(e.message); }
    }
  }
  return { items: mockData.insiderTransactions, source: "mock", notes };
}

/** Market scan (~550 stocks, chart-only) written by the daily job. Static JSON only; null when not deployed yet. */
export async function fetchScan(settings, { signal } = {}) {
  if (settings.mode === "mock") return { data: null, source: "mock" };
  try {
    const j = await staticJson(settings, "scan.json", signal);
    if (j && j.items && j.items.length) return { data: j, source: "static-json" };
  } catch (e) { if (e.name === "AbortError") throw e; }
  return { data: null, source: "mock" };
}

/* -------------------------------------- Hooks -------------------------------------- */
/** Async resource with optional polling. Re-runs when `depKey` (e.g. the settings) changes. */
function useResource(fetcher, fallback, depKey, { pollMs = 0 } = {}) {
  const [state, setState] = useState({ data: fallback, loading: true, error: null, lastUpdated: null, source: "mock", notes: [], progress: null });
  const ctrl = useRef(null);
  const load = useCallback(async () => {
    if (ctrl.current) ctrl.current.abort();
    const c = typeof AbortController !== "undefined" ? new AbortController() : null;
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, progress: null }));
    try {
      const res = await fetcher({ signal: c && c.signal, onProgress: (done, total) => setState((s) => ({ ...s, progress: { done, total } })) });
      setState({ data: res, loading: false, error: null, lastUpdated: new Date(), source: res.source, notes: res.notes || [], progress: null });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setState((s) => ({ ...s, data: s.data || fallback, loading: false, error: String(e.message || e), lastUpdated: new Date(), progress: null }));
    }
  }, [fetcher]);
  useEffect(() => {
    load();
    if (!pollMs) return () => ctrl.current && ctrl.current.abort();
    const id = setInterval(load, pollMs);
    return () => { clearInterval(id); ctrl.current && ctrl.current.abort(); };
  }, [load, pollMs, depKey]);
  return { ...state, refresh: load };
}

const SCREENER_FALLBACK = { stocks: mockData.stocks, sectorPE: mockData.sectorPE, asOf: mockData.asOf, source: "mock" };
const FEED_FALLBACK = { items: mockData.analystFeed, source: "mock" };
const INSIDER_FALLBACK = { items: mockData.insiderTransactions, source: "mock" };

export function useScreenerData(settings) {
  const f = useCallback((o) => fetchLatestScreenerData(settings, o), [settings]);
  return useResource(f, SCREENER_FALLBACK, settings);
}
export function useAnalystFeed(settings) {
  const f = useCallback((o) => fetchAnalystFeed(settings, o), [settings]);
  // Poll precomputed sources every minute; browser-live mode is cached, so polling costs no extra quota.
  return useResource(f, FEED_FALLBACK, settings, { pollMs: settings.analystPollMs });
}
export function useInsiderActivity(settings) {
  const f = useCallback((o) => fetchInsiderActivity(settings, o), [settings]);
  return useResource(f, INSIDER_FALLBACK, settings);
}

export function useScan(settings) {
  const f = useCallback((o) => fetchScan(settings, o), [settings]);
  const r = useResource(f, { data: null, source: "mock" }, settings);
  return { ...r, data: r.data && r.data.data };
}

/** Settings drawer state (persisted per browser). */
export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);
  const update = useCallback((next) => { saveSettings(next); setSettings(next); }, []);
  return [settings, update];
}

/* --------------------------------- Portfolio state --------------------------------- */
const STORE_KEY = "wealth-engine-portfolio-v2";
const newId = () => "h" + Math.random().toString(36).slice(2, 9);

function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const p = raw && JSON.parse(raw);
    if (Array.isArray(p)) return p.map((h) => ({ id: h.id || newId(), ...h }));
  } catch (e) {}
  return mockData.samplePortfolio.map((h) => ({ ...h }));
}

const UPDATED_KEY = "wealth-engine-portfolio-updated";
const SYNC_KEY = "wealth-engine-sync-code";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
const cleanHoldings = (list) => (Array.isArray(list) ? list : []).filter((h) => h && h.ticker)
  .map((h) => ({ id: h.id || newId(), ticker: String(h.ticker).toUpperCase(), shares: Number(h.shares) || 0, cost: Number(h.cost) || 0 }));
const syncClient = createSyncClient(SYNC_CONFIG);

/**
 * Add / edit / delete handlers for portfolio items. Saved in this browser, and — once sync is on —
 * kept the same on every device through Supabase (see lib/sync.js).
 */
export function usePortfolio() {
  const [state, setState] = useState(() => ({ holdings: loadHoldings(), updatedAt: lsGet(UPDATED_KEY), local: false }));
  const [code, setCode] = useState(() => lsGet(SYNC_KEY));
  const [sync, setSync] = useState({ status: lsGet(SYNC_KEY) ? "syncing" : "off", at: null, error: null, note: null });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist locally on every change.
  useEffect(() => {
    lsSet(STORE_KEY, JSON.stringify(state.holdings));
    lsSet(UPDATED_KEY, state.updatedAt);
  }, [state]);

  const edit = useCallback((fn) => setState((s) => ({ holdings: fn(s.holdings), updatedAt: new Date().toISOString(), local: true })), []);
  const addHolding = useCallback(({ ticker, shares, cost }) => edit((prev) => {
    const i = prev.findIndex((h) => h.ticker === ticker);
    if (i < 0) return [...prev, { id: newId(), ticker, shares, cost: ticker === "CASH" ? 1 : cost }];
    const cur = prev[i], total = cur.shares + shares;
    const blended = ticker === "CASH" ? 1 : (cur.shares * cur.cost + shares * cost) / total;
    return prev.map((h, j) => (j === i ? { ...h, shares: total, cost: blended } : h));
  }), [edit]);
  const updateHolding = useCallback((id, patch) => edit((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch, cost: h.ticker === "CASH" ? 1 : patch.cost ?? h.cost } : h))), [edit]);
  const deleteHolding = useCallback((id) => edit((prev) => prev.filter((h) => h.id !== id)), [edit]);
  const resetPortfolio = useCallback(() => edit(() => mockData.samplePortfolio.map((h) => ({ ...h }))), [edit]);

  // Take the cloud copy when it's newer than this device's last edit.
  const applyRemote = useCallback((remote) => {
    if (!remote || !remote.data) return false;
    const mine = stateRef.current.updatedAt ? Date.parse(stateRef.current.updatedAt) : 0;
    if (Date.parse(remote.updated_at) > mine) {
      setState({ holdings: cleanHoldings(remote.data.holdings), updatedAt: remote.updated_at, local: false });
      return true;
    }
    return false;
  }, []);

  const pull = useCallback(async (c) => {
    if (!syncClient || !c) return;
    try {
      const remote = await syncClient.load(c);
      if (remote) applyRemote(remote);
      else { // nothing saved under this code yet → upload this device's portfolio
        const s = stateRef.current;
        await syncClient.save(c, { holdings: s.holdings }, s.updatedAt || new Date().toISOString());
      }
      setSync((x) => ({ ...x, status: "synced", at: new Date(), error: null }));
    } catch (e) { setSync((x) => ({ ...x, status: "error", error: e.message })); }
  }, [applyRemote]);

  // Upload local edits (debounced).
  useEffect(() => {
    if (!syncClient || !code || !state.local) return;
    setSync((x) => ({ ...x, status: "syncing" }));
    const t = setTimeout(async () => {
      try {
        const stored = await syncClient.save(code, { holdings: state.holdings }, state.updatedAt);
        if (stored) applyRemote(stored); // another device edited later → take theirs
        setSync((x) => ({ ...x, status: "synced", at: new Date(), error: null }));
      } catch (e) { setSync((x) => ({ ...x, status: "error", error: e.message })); }
    }, 800);
    return () => clearTimeout(t);
  }, [state, code, applyRemote]);

  // Check the cloud on open, every 30 s, and whenever the tab/app comes back into view.
  useEffect(() => {
    if (!syncClient || !code) return;
    pull(code);
    const id = setInterval(() => document.visibilityState === "visible" && pull(code), 30000);
    const onVis = () => document.visibilityState === "visible" && pull(code);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [code, pull]);

  const startSync = useCallback(() => {
    const c = newSyncCode();
    lsSet(SYNC_KEY, c); setCode(c);
    setSync({ status: "syncing", at: null, error: null, note: "Sync is on. Open the sync link on your other device." });
  }, []);
  const joinSync = useCallback((raw) => {
    const c = normalizeSyncCode(raw);
    if (!c) { setSync((x) => ({ ...x, error: "That code doesn't look right: it should be 20 letters/numbers." })); return false; }
    // Joining takes the synced portfolio over whatever is on this device.
    setState((s) => ({ ...s, updatedAt: null, local: false }));
    stateRef.current = { ...stateRef.current, updatedAt: null };
    lsSet(SYNC_KEY, c); setCode(c);
    setSync({ status: "syncing", at: null, error: null, note: "Connected. This device now shows your synced portfolio." });
    return true;
  }, []);
  const stopSync = useCallback(() => {
    lsSet(SYNC_KEY, null); setCode(null);
    setSync({ status: "off", at: null, error: null, note: "Sync is off on this device. Your holdings stay saved here." });
  }, []);

  // A sync link (…/#sync=CODE) connects this device, then the code is removed from the address bar.
  useEffect(() => {
    const m = /[#&]sync=([A-Za-z0-9-]+)/.exec(window.location.hash || "");
    if (!m) return;
    const c = normalizeSyncCode(m[1]);
    if (c && c !== lsGet(SYNC_KEY)) joinSync(c);
    try { history.replaceState(null, "", window.location.pathname + window.location.search + "#portfolio"); } catch (e) {}
  }, [joinSync]);

  const syncLink = code ? window.location.origin + window.location.pathname + "#portfolio&sync=" + code : null;
  return {
    holdings: state.holdings, addHolding, updateHolding, deleteHolding, resetPortfolio,
    sync: { available: !!syncClient, code, link: syncLink, ...sync, start: startSync, join: joinSync, stop: stopSync, refresh: () => pull(code) },
  };
}
