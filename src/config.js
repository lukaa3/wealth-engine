/**
 * config.js — runtime settings.
 * Defaults come from Vite env vars (VITE_*) baked in at build time, then any values the
 * visitor saves in the in-app Settings drawer (stored in this browser's localStorage) override them.
 *
 * NOTE: anything in a VITE_ variable ends up in the public JS bundle on GitHub Pages.
 * Only put PUBLIC values there (Supabase URL + anon key). Vendor API keys belong in
 * GitHub Actions secrets (for the cron job) or in each visitor's own Settings drawer.
 */
const ENV = import.meta.env || {};

export const SETTINGS_KEY = "wse-settings-v1";

export const DEFAULT_SETTINGS = {
  mode: "auto", // "auto" = Supabase → static JSON → browser APIs → sample data; "mock" = sample data only
  supabaseUrl: ENV.VITE_SUPABASE_URL || "",
  supabaseAnonKey: ENV.VITE_SUPABASE_ANON_KEY || "",
  supabaseData: ENV.VITE_SUPABASE_DATA === "on", // read screener tables from Supabase (only if the Action writes them)
  staticJsonUrl: ENV.VITE_STATIC_JSON_URL || "./data", // folder the GitHub Action writes screener.json etc. into
  fmpKey: ENV.VITE_FMP_API_KEY || "",
  finnhubKey: ENV.VITE_FINNHUB_API_KEY || "",
  alphaVantageKey: ENV.VITE_ALPHA_VANTAGE_API_KEY || "",
  watchlist: ENV.VITE_WATCHLIST || "", // comma-separated tickers; empty = default universe
  analystPollMs: 60000,
  quoteTtlMin: 5,
  fundamentalsTtlHours: 24,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

export const hasSupabase = (s) => !!(s.supabaseUrl && s.supabaseAnonKey);
/** Screener data comes from Supabase only when switched on; the same project can be used just for portfolio sync. */
export const hasSupabaseData = (s) => hasSupabase(s) && !!s.supabaseData;
/** Portfolio sync settings: baked into the site at build time, so every device gets them without setup. */
export const SYNC_CONFIG = { url: ENV.VITE_SUPABASE_URL || "", key: ENV.VITE_SUPABASE_ANON_KEY || "" };
export const hasVendorKeys = (s) => !!(s.fmpKey || s.finnhubKey || s.alphaVantageKey);
export const parseWatchlist = (s, fallback) => {
  const list = String(s.watchlist || "").split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  return list.length ? Array.from(new Set(list)) : fallback;
};
