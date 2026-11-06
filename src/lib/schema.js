/**
 * schema.js — maps between app records (camelCase) and database / JSON rows (snake_case).
 * Used by api.js (reading) and scripts/update-screener.mjs (writing). Matches supabase/schema.sql.
 */
const toNum = (v) => (v == null || v === "" ? null : Number(v));

export function stockToRow(s) {
  return {
    ticker: s.ticker, name: s.name, sector: s.sector, price: s.price, beta: s.beta,
    dcf_value: s.dcfValue, peg_ratio: s.peg, forward_pe: s.fwdPE,
    fvg_timeframe: s.fvg.tf, fvg_status: s.fvg.status, fvg_low: s.fvg.lo, fvg_high: s.fvg.hi,
    fib_level: s.fib, structural_support: !!s.support, stop_price: s.stop,
    target_1m: s.target1m, target_6m: s.target6m, target_12m: s.target12m,
    buy_pct: s.buyPct, analyst_count: s.analystCount,
    buy_zone_low: s.buyZone[0], buy_zone_high: s.buyZone[1],
    catalysts: s.catalysts || [], invalidation_triggers: s.invalidation || [],
    composite_score: s.composite ?? null, technical_score: s.technical ?? null,
    fundamental_score: s.fundamental ?? null, sentiment_score: s.sentiment ?? null,
    ai_take: s.ai || null,
    updated_at: new Date().toISOString(),
  };
}

export function rowToStock(r) {
  return {
    ticker: r.ticker, name: r.name, sector: r.sector, price: toNum(r.price), beta: toNum(r.beta) ?? 1,
    dcfValue: toNum(r.dcf_value), peg: toNum(r.peg_ratio), fwdPE: toNum(r.forward_pe),
    fvg: { tf: r.fvg_timeframe || null, status: r.fvg_status || "None", lo: toNum(r.fvg_low), hi: toNum(r.fvg_high) },
    fib: toNum(r.fib_level), support: !!r.structural_support, stop: toNum(r.stop_price),
    target1m: toNum(r.target_1m), target6m: toNum(r.target_6m), target12m: toNum(r.target_12m),
    buyPct: toNum(r.buy_pct), analystCount: toNum(r.analyst_count),
    buyZone: [toNum(r.buy_zone_low), toNum(r.buy_zone_high)],
    catalysts: r.catalysts || [], invalidation: r.invalidation_triggers || [],
    ai: r.ai_take || null,
    updatedAt: r.updated_at || null,
  };
}

export const actionToRow = (a) => ({
  action_date: a.date, ticker: a.ticker, firm: a.firm, action: a.action, from_rating: a.fromRating, to_rating: a.toRating,
  old_target: a.oldTarget, new_target: a.newTarget, rationale: a.rationale, source_name: a.source, source_url: a.url || null,
  headline: a.headline || null,
});
export const rowToAction = (r) => ({
  date: String(r.action_date).slice(0, 10), ticker: r.ticker, firm: r.firm, action: r.action,
  fromRating: r.from_rating || "—", toRating: r.to_rating, oldTarget: toNum(r.old_target), newTarget: toNum(r.new_target),
  rationale: r.rationale, source: r.source_name, url: r.source_url || null, headline: r.headline || null,
});

export const insiderToRow = (t) => ({
  filing_date: t.date, ticker: t.ticker, insider_role: t.role, shares: t.shares, value: t.value, is_10b5_1: !!t.planned, filing_url: t.url || null,
});
export const rowToInsider = (r) => ({
  date: String(r.filing_date).slice(0, 10), ticker: r.ticker, role: r.insider_role, shares: toNum(r.shares),
  value: toNum(r.value), planned: !!r.is_10b5_1, url: r.filing_url || null,
});
