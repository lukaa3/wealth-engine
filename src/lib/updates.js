/**
 * updates.js — the daily "Update:" line for each stock.
 *
 * Nightly (scripts/update-screener.mjs): every stock keeps a short history of [date, score, price, above200, revUp, revDown]
 * and gets `upd` = what changed since the last trading day (score / pick tier, big price moves, the 200-day trend,
 * earnings, estimate cuts, bad headlines). The site then adds what to do about it: for a stock you own that comes
 * from the portfolio advisor (buy more / hold / take profit / get out); for one you don't, from the pick tier.
 */
import { LIMITS } from "../scoring.js";

const HIST_KEEP = 40;
const fmtPct = (x) => (x >= 0 ? "+" : "") + (Math.abs(x) < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";
export const tierOf = (score) => (score == null ? null : score >= LIMITS.HIGH_CONVICTION ? 3 : score >= LIMITS.RECOMMEND ? 2 : score >= LIMITS.WATCH ? 1 : 0);
const TIER_NAME = ["not a pick", "Watchlist", "Recommended", "Top pick"];

/** History with today's entry added (a second run on the same day replaces it). */
export function nextHist(prevHist, s, today) {
  const f = s.factors || {};
  const h = (Array.isArray(prevHist) ? prevHist : []).filter((e) => e[0] !== today);
  h.push([today, s.composite ?? null, s.price ?? null, f.above200 ?? null, f.revUp ?? null, f.revDown ?? null]);
  return h.slice(-HIST_KEEP);
}

/**
 * What changed for one stock. `hist` already includes today. `dayMove` = today's % change (from the chart),
 * `reportedOn` = an earnings date in the last few days (or null), `prevSurprise` = the latest surprise before tonight.
 * → { date, tone: "good" | "bad" | "neutral", events: [{ text, tone }] }
 */
export function stockUpdate(s, hist, { today, dayMove = null, reportedOn = null, prevSurprise = null } = {}) {
  const f = s.factors || {};
  const past = hist.filter((e) => e[0] < today);
  const ref = past[past.length - 1] || null; // last trading day we have
  const wk = past.length >= 5 ? past[past.length - 5] : null; // about a week ago
  const ev = [];
  const add = (text, tone) => ev.push({ text, tone });
  const score = s.composite;

  if (ref && ref[1] != null && score != null) {
    const t0 = tierOf(ref[1]), t1 = tierOf(score);
    if (t1 > t0 && t1 >= 2) add("Upgraded to " + TIER_NAME[t1] + " (score " + ref[1] + " → " + score + ")", "good");
    else if (t1 < t0 && t0 >= 2) add((t1 >= 2 ? "Slipped to " + TIER_NAME[t1] : "Dropped out of the picks") + " (score " + ref[1] + " → " + score + ")", "bad");
    else if (Math.abs(score - ref[1]) >= 5) add("Score " + (score > ref[1] ? "up" : "down") + " " + ref[1] + " → " + score, score > ref[1] ? "good" : "bad");
  }
  if (dayMove != null && Math.abs(dayMove) >= 0.04) add((dayMove > 0 ? "Jumped " : "Fell ") + fmtPct(dayMove) + " today", dayMove > 0 ? "good" : "bad");
  else if (wk && wk[2] && s.price) {
    const w = s.price / wk[2] - 1;
    if (Math.abs(w) >= 0.1) add((w > 0 ? "Up " : "Down ") + fmtPct(w) + " this week", w > 0 ? "good" : "bad");
  }
  if (ref && ref[3] != null && f.above200 != null && ref[3] !== f.above200)
    add(f.above200 ? "Back above its 200-day average (uptrend)" : "Fell below its 200-day average (not a sell signal by itself)", f.above200 ? "good" : "bad");
  if (reportedOn) {
    const sur = Array.isArray(f.surprises) && f.surprises.length ? f.surprises[0] : null;
    const fresh = sur != null && sur !== prevSurprise;
    add("Reported earnings" + (fresh ? (sur >= 0 ? ": beat by " + fmtPct(sur) : ": missed by " + fmtPct(-sur)) : ""), fresh ? (sur >= 0 ? "good" : "bad") : "neutral");
  }
  if (ref && ref[5] != null && f.revDown != null && f.revDown - ref[5] >= 2) add("Analysts cut earnings estimates", "bad");
  else if (ref && ref[4] != null && f.revUp != null && f.revUp - ref[4] >= 2) add("Analysts raised earnings estimates", "good");
  const news = (s.newsFlags || []).filter((n) => n.date && (Date.parse(today) - Date.parse(n.date)) / 864e5 <= 2);
  if (news.length) add("Headline: " + news[0].headline, "bad");

  const g = ev.filter((e) => e.tone === "good").length, b = ev.filter((e) => e.tone === "bad").length;
  return { date: today, tone: b > g ? "bad" : g > b ? "good" : "neutral", events: ev.slice(0, 4) };
}

/**
 * What to do, in plain words. `holding` = the portfolio row for this stock if you own it (with .advice and .plPct).
 * → { text, tone }
 */
export function updateAdvice(s, holding) {
  const upd = s.upd;
  if (holding && holding.advice) {
    const a = holding.advice.action, pl = holding.plPct || 0;
    if (a === "Sell") return pl >= 0 ? { text: "Sell and lock in the profit (" + fmtPct(pl) + ")", tone: "bad" } : { text: "Get out and take the loss (" + fmtPct(pl) + "): the trend broke", tone: "bad" };
    if (a === "Trim") return { text: "Too much of your money is in this one: sell a little (you're " + fmtPct(pl) + ")", tone: "neutral" };
    if (a === "Review") return { text: "Read the news, but don't panic-sell: selling after drops did worse in the test", tone: "bad" };
    if (a === "Pause adding") return { text: "Hold, but don't add more", tone: "neutral" };
    if (a === "Buy more") return { text: upd && upd.tone === "bad" ? "Buy more: buying strong picks after a drop did better in the test" : "Looking good: buy more", tone: "good" };
    const rough = upd && upd.tone === "bad";
    return { text: (rough ? "Keep holding: in the test, selling after drops did worse" : "Keep holding") + (pl ? " (you're " + fmtPct(pl) + ")" : ""), tone: rough ? "neutral" : "good" };
  }
  const t = tierOf(s.composite);
  const upgraded = upd && upd.events.some((e) => e.text.startsWith("Upgraded"));
  if (t >= 2) return { text: upgraded ? "New buy" : upd && upd.tone === "bad" ? "Still a buy: drops in strong picks were good times to buy in the test" : "Still a buy", tone: "good" };
  if (upd && upd.events.some((e) => e.text.startsWith("Dropped out"))) return { text: "No longer a pick: skip it for now", tone: "bad" };
  return { text: t === 1 ? "Watch only, not a buy yet" : "Not a buy", tone: "neutral" };
}
