/**
 * sync.js — keeps the portfolio the same on every device (phone, Mac, …) through Supabase.
 *
 * No login: each portfolio is stored under a long random sync code. The code is the only way in —
 * the database stores just its SHA-256 hash, and the table is closed except through two functions
 * (supabase/portfolio-sync.sql). Anyone with the code can see and edit that portfolio, so keep it private.
 * Last edit wins: each save carries the time of the edit, and older saves never overwrite newer ones.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

export function newSyncCode() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{4}/g).join("-"); // e.g. K7QM-2XPA-…  (5 groups of 4 ≈ 99 bits)
}

/** Accepts the code with or without dashes / spaces, any case. */
export function normalizeSyncCode(raw) {
  const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length >= 16 ? c.match(/.{1,4}/g).join("-") : null;
}

export function createSyncClient({ url, key }) {
  if (!url || !key) return null;
  const base = url.replace(/\/$/, "");
  const rpc = async (fn, body) => {
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      // New-style keys (sb_publishable_…) go only in the apikey header; legacy anon keys are JWTs and also go as Bearer.
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "";
      try { const j = await res.json(); msg = j.message || j.hint || ""; } catch (e) {}
      throw new Error("Sync failed (HTTP " + res.status + (msg ? ": " + msg : "") + ")");
    }
    const text = await res.text();
    return text && text !== "null" ? JSON.parse(text) : null;
  };
  return {
    /** → { data: { holdings }, updated_at } or null when nothing is saved under this code yet. */
    load: (code) => rpc("get_portfolio", { p_code: code }),
    /** Saves if this edit is newer than what's stored; returns what's stored afterwards. */
    save: (code, data, updatedAt) => rpc("save_portfolio", { p_code: code, p_data: data, p_updated_at: updatedAt }),
  };
}
