/**
 * App.jsx — Wealth & Stock Intelligence Engine (UI): long-term picks (core / long-term), short-term trades (backtested
 * setups with time exits), analyst & insider intelligence, portfolio advisor.
 */
import React, { useState, useMemo, useEffect, useRef, useCallback, createContext, useContext } from "react";
import * as LucideIcons from "lucide-react";
import { SECTORS, SECTOR_COLORS, SOURCE_URLS, insiderSourceUrl } from "./mockData.js";
import { LIMITS, FACTORS, HORIZON_INFO, UNMANAGED_SECTORS, scoreUniverse, analyzePortfolio, suggestedSize, planNewMoney, nextCheckup, inCheckupWindow } from "./scoring.js";
import { SETUPS, RULED_OUT, tradePlanFor } from "./lib/shortterm.js";
import { useScreenerData, useAnalystFeed, useInsiderActivity, useScan, useShort, usePortfolio, useSettings, clearLiveCache } from "./api.js";
import { DEFAULT_SETTINGS } from "./config.js";
import { ruleSummary, PROMPT_VERSION } from "./lib/ai.js";
import { updateAdvice, tierOf } from "./lib/updates.js";

const L = LIMITS;
/** Your portfolio's total value, so buy plans can say "about $X" instead of only "% of portfolio". */
const PortfolioValue = createContext(0);
const HoldingRows = createContext({}); // ticker → your portfolio row (with advice), for the daily Update line

/* ================================ Icons ================================ */
function Icon({ name, size = 16, className = "" }) {
  const lib = (typeof window !== "undefined" && window.LucideReact) || LucideIcons;
  const Comp = lib && lib[name];
  if (Comp) return <Comp size={size} className={className} aria-hidden="true" strokeWidth={2} />;
  // Fallback: vanilla lucide icon nodes (if only the non-React build is available).
  const lu = typeof window !== "undefined" && window.lucide && (window.lucide.icons || window.lucide);
  const node = lu && lu[name];
  let kids = null;
  if (Array.isArray(node)) kids = (node[0] === "svg" ? node[2] : node).map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }));
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {kids || <circle cx="12" cy="12" r="4" />}
    </svg>
  );
}

/* ============================== Formatting ============================== */
const ok = (x) => x != null && isFinite(x);
const usd = (x, d = 0) => (!ok(x) ? "—" : (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const px = (x) => usd(x, x < 1000 ? 2 : 0);
const pct = (x, d = 1) => (!ok(x) ? "—" : (x * 100).toFixed(d) + "%");
const spct = (x, d = 1) => (!ok(x) ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
const compact = (x) => {
  const a = Math.abs(x), sgn = x < 0 ? "-" : x > 0 ? "+" : "";
  return sgn + "$" + (a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "K" : Math.round(a));
};
const fmtDate = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
const tone = (x) => (x > 0 ? "text-emerald-400" : x < 0 ? "text-rose-400" : "text-slate-400");

/* ============================ Shared pieces ============================ */
function Card({ className = "", children }) {
  return <div className={"rounded-xl border border-slate-700/60 bg-slate-800 " + className}>{children}</div>;
}

function ScoreBadge({ score, size = "md" }) {
  const low = score < L.REVIEW_SCORE;
  const cls = low ? "bg-rose-500/15 text-rose-300 ring-rose-500/40" : "bg-indigo-500 text-white ring-indigo-400/50";
  const sz = size === "lg" ? "h-12 w-12 text-lg" : size === "sm" ? "h-7 min-w-[1.75rem] px-1.5 text-xs" : "h-9 w-9 text-sm";
  return <span className={"inline-flex shrink-0 items-center justify-center rounded-lg font-bold tabular-nums ring-1 " + cls + " " + sz} title={"Composite score " + score + " / 100"}>{score}</span>;
}

function Stat({ label, value, sub, valueTone, icon }) {
  const t = valueTone === "up" ? "text-emerald-400" : valueTone === "down" ? "text-rose-400" : "text-slate-100";
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">{icon && <Icon name={icon} size={14} />}{label}</div>
      <div className={"mt-1.5 text-2xl font-semibold tabular-nums " + t}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-800 p-1 ring-1 ring-slate-700/60">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={"flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition " + (value === o.value ? "bg-indigo-500 text-white shadow" : "text-slate-300 hover:bg-slate-700 hover:text-white")}>
          {o.icon && <Icon name={o.icon} size={13} />}{o.label}
        </button>
      ))}
    </div>
  );
}

function SectorChip({ sector }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      <span className="h-2 w-2 rounded-sm" style={{ background: SECTOR_COLORS[sector] }} />{sector}
    </span>
  );
}

function InsiderChip({ insider, short = false }) {
  const net = insider ? insider.net : 0;
  const label = net >= 1e6 ? "Net buying" : net > 0 ? "Light buying" : net >= -5e5 ? "Neutral" : "Net selling";
  const cls = net > 0 ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : net >= -5e5 ? "bg-slate-700/60 text-slate-300 ring-slate-600/50" : "bg-rose-500/15 text-rose-300 ring-rose-500/30";
  const icon = net > 0 ? "ArrowUpRight" : net >= -5e5 ? "Minus" : "ArrowDownRight";
  return (
    <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 " + cls} title="Net open-market insider $ flow, trailing 90 days">
      <Icon name={icon} size={12} />{short ? (net !== 0 ? compact(net) : "Neutral") : <>Insiders: {label}{net !== 0 && <span className="tabular-nums opacity-80"> {compact(net)}</span>}</>}
    </span>
  );
}

function PillarBars({ s }) {
  return (
    <div className="space-y-1.5">
      {FACTORS.map((p) => (
        <div key={p.k} className="flex items-center gap-2 text-[11px]">
          <span className="w-32 shrink-0 text-slate-400">{p.label}</span>
          <div className="h-1.5 flex-1 rounded-full bg-slate-700"><div className="h-1.5 rounded-full bg-indigo-400" style={{ width: Math.max(0, (s[p.k] / p.max) * 100) + "%" }} /></div>
          <span className="w-12 shrink-0 text-right tabular-nums text-slate-300">{s[p.k]}<span className="text-slate-500">/{p.max}</span></span>
        </div>
      ))}
    </div>
  );
}

const RISK_STYLE = {
  Low: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  Medium: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  High: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
};
function RiskChip({ risk }) {
  return <span title="Based on how much the price swings, whether it's profitable, and company size" className={"inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 " + (RISK_STYLE[risk] || RISK_STYLE.Medium)}><Icon name="Gauge" size={12} />{risk} risk</span>;
}
function HorizonChip({ s }) {
  const h = HORIZON_INFO[s.horizon] || HORIZON_INFO.core;
  return <span title="The holding period this stock's strengths fit best" className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-2 py-0.5 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-500/30"><Icon name={h.icon} size={12} />{h.label} · {h.span}</span>;
}
/** The plan in plain words: how much to buy (all at once), where the idea is wrong, where to take profit. */
function BuyPlanBox({ s }) {
  const total = useContext(PortfolioValue);
  const bp = s.buyPlan;
  if (!bp) return null;
  const h = HORIZON_INFO[s.horizon] || HORIZON_INFO.core;
  const size = suggestedSize(s, total);
  if (s.composite < L.RECOMMEND) {
    // Only Recommended (65+) and Top picks (75+) are buys; that's what was backtested.
    const watch = s.composite >= L.WATCH;
    return (
      <div className="rounded-lg bg-slate-900/60 p-3">
        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400"><Icon name="ListChecks" size={12} />Plan</div>
        <div className="mt-1.5 text-sm font-semibold text-slate-200">{watch ? "Not a buy yet" : "Not a buy"}: score {s.composite}, picks start at {L.RECOMMEND}</div>
        <p className="mt-0.5 text-xs text-slate-400">{watch ? "It's on the watchlist. If the score climbs to " + L.RECOMMEND + "+, it becomes a buy and shows a plan here." : "Skip it for now."} If you own it, hold until the next 3-month check-up and sell it then if it's still under {L.RECOMMEND}.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400"><Icon name="ListChecks" size={12} />Plan · {h.label.toLowerCase()} hold</span>
        {s.plan.status === "live" && <span className="rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-slate-900" title={"FVG " + px(s.fvg.lo) + "–" + px(s.fvg.hi) + ", reward:risk " + s.plan.rr.toFixed(1) + ":1"}>FVG entry live</span>}
      </div>
      <div className="mt-1.5 text-sm">
        <span className="font-semibold text-emerald-300">Buy now, all at once: </span>
        <span className="font-semibold text-white">{size.amount ? "~" + usd(size.amount) : Math.round(size.pct * 100) + "% of your portfolio"}</span>
        <span className="block text-xs text-slate-400">{size.amount ? Math.round(size.pct * 100) + "% of your portfolio · " : ""}~{px(s.price)} · {s.risk} risk{s.composite >= L.HIGH_CONVICTION ? " · Top pick" : ""}</span>
      </div>
      {!size.amount && <p className="mt-0.5 text-xs text-slate-500">Add your holdings in the Portfolio tab to see dollars.</p>}
      {bp.note && <p className="mt-1.5 flex gap-1.5 text-xs text-amber-300"><Icon name="Hourglass" size={13} className="mt-0.5 shrink-0" />{bp.note}</p>}
      <div className="mt-2 grid gap-1 border-t border-slate-700/60 pt-2 text-xs">
        <div className="flex gap-1.5 text-rose-300"><Icon name="XCircle" size={13} className="mt-0.5 shrink-0" /><span><span className="font-semibold">Rethink below {px(bp.stop)}</span> <span className="text-rose-300/70">({spct(bp.stopPct, 0)})</span>: the idea is wrong there.</span></div>
        <div className="flex gap-1.5 text-emerald-300"><Icon name="Flag" size={13} className="mt-0.5 shrink-0" /><span>{bp.take.text}</span></div>
      </div>
    </div>
  );
}

/** "Update: what changed since yesterday → what to do." Server writes the changes; the advice depends on whether you own it. */
function UpdateBox({ s, compact = false }) {
  const rows = useContext(HoldingRows);
  const h = rows[s.ticker];
  const upd = s.upd && s.upd.date && (Date.now() - Date.parse(s.upd.date)) / 864e5 <= 5 ? s.upd : null;
  if (!upd && !(h && h.advice)) return null;
  const adv = updateAdvice(s, h);
  const ev = upd ? upd.events : [];
  const tone = adv.tone === "bad" || (upd && upd.tone === "bad") ? "bad" : adv.tone === "good" ? "good" : "neutral";
  const box = { good: "border-emerald-500/30 bg-emerald-500/5", bad: "border-rose-500/40 bg-rose-500/5", neutral: "border-slate-600/60 bg-slate-900/40" }[tone];
  const head = { good: "text-emerald-300", bad: "text-rose-300", neutral: "text-slate-200" }[tone];
  return (
    <div className={"rounded-lg border p-2.5 text-sm " + box}>
      <div className={"flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide " + head}>
        <Icon name={tone === "bad" ? "AlertTriangle" : tone === "good" ? "TrendingUp" : "Info"} size={13} />
        Update{upd ? " · " + fmtDate(upd.date) : ""}{h ? " · you own it" : ""}
      </div>
      <div className="mt-0.5 font-semibold text-white">{adv.text}</div>
      {ev.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {(compact ? ev.slice(0, 2) : ev).map((e) => (
            <li key={e.text} className="flex gap-1.5 text-xs text-slate-300">
              <span className={e.tone === "good" ? "text-emerald-400" : e.tone === "bad" ? "text-rose-400" : "text-slate-500"}>{e.tone === "good" ? "▲" : e.tone === "bad" ? "▼" : "•"}</span>
              <span className={compact ? "truncate" : ""}>{e.text}</span>
            </li>
          ))}
        </ul>
      ) : <div className="mt-0.5 text-xs text-slate-400">No big changes since the last check.</div>}
      {!compact && h && h.advice && h.advice.why[0] && <div className="mt-1 text-xs text-slate-400">Why: {h.advice.why[0]}</div>}
    </div>
  );
}

/** The long-term rule in one place: hold; every 3 months sell what's no longer a pick. */
function CheckupBanner({ rows }) {
  const c = nextCheckup(), now = inCheckupWindow();
  const toSell = rows.filter((r) => r.advice && r.advice.checkup === "sell").map((r) => r.ticker);
  const outNow = rows.filter((r) => r.advice && r.advice.checkup === "wait").map((r) => r.ticker);
  return (
    <div className={"mt-2 rounded-lg border p-3 text-sm " + (now ? "border-amber-500/40 bg-amber-500/10" : "border-slate-700 bg-slate-900/40")}>
      <div className="flex items-center gap-2 font-semibold text-white">
        <Icon name="CalendarCheck" size={15} className={now ? "text-amber-300" : "text-indigo-300"} />
        {now ? "It's 3-month check-up week" : "Next 3-month check-up: " + fmtDate(c.date) + " (in " + c.days + " days)"}
      </div>
      <p className="mt-1 text-xs text-slate-300">
        {now
          ? (toSell.length ? "Sell " + toSell.join(", ") + (toSell.length > 1 ? " (no longer picks)" : " (no longer a pick)") + " and put the money into current top picks. Keep everything else." : "Everything you own is still a pick: keep it all. Add new money to current top picks.")
          : "Long-term stocks have no price target or time limit: hold through the ups and downs. At each check-up (end of Mar, Jun, Sep, Dec), sell only what's no longer a pick." + (outNow.length ? " Out of the picks right now: " + outNow.join(", ") + " (hold until the check-up; sell then if still out)." : "")}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">This is how the 10-year test was run. Selling early on drops did worse; the only other sells are a broken downtrend or one stock growing past 20% of your money.</p>
    </div>
  );
}

/* ===================== Search any stock (header) ===================== */
const TIER_LABEL = ["Below the picks", "Watchlist", "Recommended", "Top pick"];
const TIER_TONE = ["text-slate-400", "text-sky-300", "text-emerald-300", "text-amber-300"];

function StockSearch({ scanItems, rankedCount, byTicker, shortItems, holdingRows, onOpen, onGoShort }) {
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setFocus(false); };
    document.addEventListener("mousedown", away); document.addEventListener("touchstart", away);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); };
  }, []);
  const shortBy = useMemo(() => Object.fromEntries((shortItems || []).map((x) => [x.ticker, x])), [shortItems]);
  const all = useMemo(() => {
    const m = new Map();
    (scanItems || []).forEach((r) => m.set(r.ticker, { ticker: r.ticker, name: r.name || "", price: r.price, fund: r.fund, sc: r.sc, rk: r.rk, ret20: r.ret20, above200: r.above200 }));
    Object.values(byTicker).forEach((st) => { if (!m.has(st.ticker)) m.set(st.ticker, { ticker: st.ticker, name: st.name || "", price: st.price }); });
    return [...m.values()];
  }, [scanItems, byTicker]);
  const results = useMemo(() => {
    const qq = q.trim().toUpperCase();
    if (!qq) return [];
    const score = (r) => (r.ticker === qq ? 0 : r.ticker.startsWith(qq) ? 1 : r.name.toUpperCase().startsWith(qq) ? 2 : r.name.toUpperCase().includes(qq) ? 3 : 9);
    return all.map((r) => [score(r), r]).filter(([v]) => v < 9).sort((a, b) => a[0] - b[0] || a[1].ticker.length - b[1].ticker.length).slice(0, 8).map(([, r]) => r);
  }, [q, all]);
  const pickRow = (r) => {
    if (byTicker[r.ticker]) { onOpen(r.ticker); setQ(""); setFocus(false); }
    else if (shortBy[r.ticker]) { onGoShort(); setQ(""); setFocus(false); }
  };
  return (
    <div ref={box} className="relative w-full sm:w-72">
      <label className="relative block">
        <span className="sr-only">Search any stock</span>
        <Icon name="Search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input value={q} onChange={(e) => { setQ(e.target.value); setFocus(true); }} onFocus={() => setFocus(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) pickRow(results[0]); if (e.key === "Escape") { setQ(""); setFocus(false); } }}
          placeholder="Search any stock (e.g. MU, Micron)" autoComplete="off" spellCheck={false}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-8 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none" />
      </label>
      {focus && q.trim() && (
        <div className="absolute right-0 z-50 mt-1 max-h-[70vh] w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 shadow-2xl sm:w-[26rem]">
          {results.length === 0 ? (
            <div className="p-3 text-sm text-slate-400">Not found. The site scans US stocks worth about $2B or more; tiny companies and non-US listings aren't included.</div>
          ) : results.map((r) => {
            const st = byTicker[r.ticker], sh = shortBy[r.ticker], own = !!holdingRows[r.ticker];
            const sc = st ? st.composite : r.sc;
            const t = tierOf(sc);
            const clickable = !!(st || sh);
            return (
              <button key={r.ticker} type="button" onClick={() => pickRow(r)} disabled={!clickable}
                className={"block w-full border-b border-slate-700/60 px-3 py-2.5 text-left last:border-0 " + (clickable ? "hover:bg-slate-700/60" : "cursor-default")}>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 truncate"><span className="font-bold text-white">{r.ticker}</span> <span className="text-xs text-slate-400">{r.name}</span></div>
                  {r.price != null && <span className="shrink-0 text-sm tabular-nums text-slate-300">{px(r.price)}</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {r.fund ? <span className="text-slate-400">Fund / ETF · not scored (part of your core)</span>
                    : sc != null ? (
                      <>
                        <span className="inline-flex items-center gap-1"><ScoreBadge score={sc} size="sm" /><span className={"font-semibold " + TIER_TONE[t]}>{TIER_LABEL[t]}</span></span>
                        {r.rk && rankedCount ? <span className="text-slate-500">#{r.rk} of {rankedCount.toLocaleString()}</span> : null}
                        {st && <span className="text-slate-500">· {st.risk} risk</span>}
                      </>
                    ) : <span className="text-slate-400">Not fully checked yet (gets checked within ~5 days){r.above200 != null ? " · " + (r.above200 ? "in an uptrend" : "below its 200-day") : ""}</span>}
                  {sh && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">Short-term: {sh.setups.map((k) => (SETUPS[k] || {}).label).filter(Boolean).join(", ")}</span>}
                  {own && <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-medium text-indigo-300">You own it</span>}
                </div>
                {clickable && <div className="mt-1 text-[11px] text-indigo-300">{st ? "Open full breakdown →" : "See it on the Short-term page →"}</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ===================== Tab 1: Swing & Position Picks ===================== */
const SORTS = [
  { value: "composite", label: "Overall", icon: "Award" },
  { value: "momentum", label: "Momentum", icon: "TrendingUp" },
  { value: "earnings", label: "Earnings", icon: "Activity" },
  { value: "quality", label: "Quality", icon: "ShieldCheck" },
  { value: "value", label: "Value", icon: "Scale" },
];
const HORIZONS = [
  { value: "all", label: "All" },
  { value: "core", label: "Core · 3–12 mo", icon: "CalendarRange" },
  { value: "long", label: "Long-term · 1–3+ yr", icon: "Sprout" },
];
const RISKS = [
  { value: "all", label: "Any risk" },
  { value: "Low", label: "Low" },
  { value: "Medium", label: "Medium" },
  { value: "High", label: "High" },
];
const sortBy = (list, key) => list.slice().sort((a, b) => b[key] - a[key] || b.composite - a.composite);

function FvgPill({ fvg }) {
  const map = {
    Rejected: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    Testing: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    None: "bg-slate-700/50 text-slate-400 ring-slate-600/40",
  };
  const label = fvg.status === "None" ? "No active FVG" : fvg.tf + " FVG " + (fvg.status === "Rejected" ? "rejection" : "testing");
  return (
    <span className={"inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 " + (map[fvg.status] || map.None)}>
      <Icon name={fvg.status === "Rejected" ? "CircleCheck" : fvg.status === "Testing" ? "Crosshair" : "Minus"} size={12} />{label}
    </span>
  );
}

const VERDICT_STYLE = {
  "Buy setup": "bg-emerald-500 text-slate-900",
  Accumulate: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  "Wait for entry": "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
  Watch: "bg-slate-700/70 text-slate-300 ring-1 ring-slate-600/50",
  Avoid: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30",
};

function AiTake({ s, full = false }) {
  const t = s.ai && (s.ai.pv || 0) >= PROMPT_VERSION ? s.ai : ruleSummary(s); // older takes may say "wait for a dip"
  const isAi = t.source === "ai";
  const when = t.generatedAt ? fmtDate(t.generatedAt.slice(0, 10)) : null;
  return (
    <div className="rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
          <Icon name={isAi ? "Sparkles" : "Calculator"} size={12} />{isAi ? "AI analyst take" : "Auto summary"}
        </span>
        <span className={"rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + (VERDICT_STYLE[t.verdict] || VERDICT_STYLE.Watch)}>{t.verdict}</span>
      </div>
      <p className="mt-1.5 text-sm text-slate-200">{t.summary}</p>
      {full && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">Bull case</div>
            <ul className="mt-1 space-y-0.5">{t.bull.length ? t.bull.map((b) => <li key={b} className="text-xs text-slate-300">+ {b}</li>) : <li className="text-xs text-slate-500">Nothing stands out</li>}</ul>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">Bear case</div>
            <ul className="mt-1 space-y-0.5">{t.bear.length ? t.bear.map((b) => <li key={b} className="text-xs text-slate-300">– {b}</li>) : <li className="text-xs text-slate-500">Nothing stands out</li>}</ul>
          </div>
        </div>
      )}
      {full && t.watch && <p className="mt-2 text-xs text-slate-300"><span className="font-semibold text-slate-100">Watch: </span>{t.watch}</p>}
      <p className="mt-1.5 text-[10px] text-slate-500">
        {isAi ? `${t.model || "AI"}${when ? " · " + when : ""}${t.stale ? " · from an earlier run" : ""} · ${t.confidence} confidence · written from the data shown here; can be wrong`
          : "Built from the scores and setup on this card. Connect a free Groq or Gemini key in the GitHub Action for an AI take."}
      </p>
    </div>
  );
}

function InvestmentCard({ s, onOpen }) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-700/60 bg-slate-800 p-4 transition hover:border-indigo-500/50">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => onOpen(s.ticker)} className="min-w-0 text-left">
          <div className="flex items-baseline gap-2"><span className="text-lg font-bold text-white hover:text-indigo-300">{s.ticker}</span><span className="text-sm tabular-nums text-slate-300">{px(s.price)}</span></div>
          <div className="truncate text-xs text-slate-400">{s.name}</div>
          <div className="mt-1"><SectorChip sector={s.sector} /></div>
        </button>
        <ScoreBadge score={s.composite} size="lg" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <HorizonChip s={s} />
        <RiskChip risk={s.risk} />
        {s.partial && s.partial.length > 0 && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300 ring-1 ring-amber-500/30" title={"Not available, scored as neutral: " + s.partial.join(", ")}>Partial data</span>
        )}
        {s.carried && s.checkedAt && <span className="rounded-md bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-slate-600/50" title="Fundamentals from this date; price and chart are from today">Checked {fmtDate(s.checkedAt)}</span>}
      </div>

      <div className="mt-3"><UpdateBox s={s} compact /></div>
      <div className="mt-3"><AiTake s={s} /></div>
      <div className="mt-3"><BuyPlanBox s={s} /></div>

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">Why it's here</div>
        <ul className="mt-1.5 space-y-1">
          {s.catalysts.slice(0, 4).map((c) => (
            <li key={c} className="flex gap-2 text-sm text-slate-300"><Icon name="TrendingUp" size={14} className="mt-0.5 shrink-0 text-emerald-400" />{c}</li>
          ))}
        </ul>
      </div>
      {(s.newsFlags || []).length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300"><Icon name="Newspaper" size={12} />Headlines to check</div>
          <ul className="mt-1 space-y-0.5">{s.newsFlags.map((n) => <li key={n.headline} className="text-xs text-slate-300">• {n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="hover:text-white hover:underline">{n.headline}</a> : n.headline} <span className="text-slate-500">({fmtDate(n.date)})</span></li>)}</ul>
        </div>
      )}
      <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-400"><Icon name="AlertTriangle" size={12} />Sell / rethink if</div>
        <ul className="mt-1 space-y-0.5">
          {s.invalidationAll.map((c) => <li key={c} className="text-xs text-slate-300">• {c}</li>)}
        </ul>
      </div>

      <div className="mt-4 border-t border-slate-700/60 pt-3"><PillarBars s={s} /></div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <InsiderChip insider={s.insider} />
        <button type="button" onClick={() => onOpen(s.ticker)} className="flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200">Full breakdown <Icon name="ArrowRight" size={12} /></button>
      </div>
    </div>
  );
}

function Methodology() {
  const [open, setOpen] = useState(false);
  const rows = [
    ["34", "Momentum & trend", "The strongest-proven signal for the next 3–12 months, and the one our 10-year backtest confirmed: stocks that went up the most over the past year (skipping the last month) tend to keep going. Ranked against every scanned stock (~2,000), plus 6-month momentum, strength vs the S&P 500, and trend (above the 200-day average, 50-day above 200-day)."],
    ["25", "Earnings momentum", "Prices follow earnings. Analysts raising their EPS estimates (last 4 weeks), the 1-month change in the consensus, expected EPS growth next year, and beating estimates in recent quarters."],
    ["15", "Quality", "Profitable, efficient companies hold up better when markets drop: operating margin, return on equity, free cash flow, and not too much debt."],
    ["15", "Valuation", "Don't overpay for growth: PEG ratio, forward P/E vs the sector, and a rough cash-flow DCF (skipped for banks)."],
    ["11", "Smart money & setup", "Insider buying, analyst consensus and price target (weak signals on their own, so small weight). The HTF bullish FVG is worth only 2 points: in the backtest it didn't predict returns, so it's used for buy levels, not for picking."],
  ];
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-700/40">
        <span className="flex items-center gap-2"><Icon name="Info" size={15} className="text-indigo-300" />How stocks are scored, labeled and planned</span>
        <Icon name="ChevronDown" size={16} className={"transition " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-700/60 px-4 py-3">
          {rows.map(([w, k, d]) => (
            <div key={k} className="flex gap-3 text-sm">
              <span className="mt-0.5 inline-flex h-6 w-10 shrink-0 items-center justify-center rounded bg-indigo-500/20 text-xs font-semibold text-indigo-300">{w}</span>
              <div><div className="font-medium text-slate-100">{k}</div><div className="text-slate-400">{d}</div></div>
            </div>
          ))}
          <div className="space-y-1.5 rounded-lg bg-slate-900/50 p-3 text-sm text-slate-400">
            <div><span className="font-medium text-slate-200">Horizon label:</span> (shorter trades are on the Short-term tab) each stock gets a fit score for <span className="text-slate-200">Core (3–12 months)</span>: the overall score; and <span className="text-slate-200">Long-term (1–3+ years)</span>: quality, growth and fair price. It's labeled with the best fit.</div>
            <div><span className="font-medium text-slate-200">Risk:</span> High = big price swings, losing money, small company or under $5. Low = calm, profitable. Being young, a mix with some High-risk names is fine; keep each one small.</div>
            <div><span className="font-medium text-slate-200">How to buy:</span> buy the whole position at once. In the 10-year test, buying all at once returned +34% over a year; buying in thirds at lower prices did +24%, because strong stocks often never come back down (and even with a 4-week deadline it only tied, for a lot more work). Stretched stocks did best of all when bought at once. The "rethink" price is where the idea is wrong.</div>
            <div><span className="font-medium text-slate-200">After you buy:</span> no price target and no time limit. Hold, and at each 3-month check-up (end of Mar, Jun, Sep, Dec) sell only what's no longer a pick, putting the money into current top picks. That's exactly how the test was run. In the 10-year test, selling early after a bad day, a -10% week, a drop from the high or a break of the 200-day average all did worse than holding (16–28% a year vs 32%), and taking profit on stretched winners only tied. What did help: putting new money into picks that are still strong, even right after a drop.</div>
            <div><span className="font-medium text-slate-200">How much:</span> about half your money in index funds (SPY/QQQ), ~22% for short-term trades, and the rest (~28%) in long-term picks. Each pick gets 4% of your portfolio if Low risk, 3% Medium, 2% High, and 25% more for Top picks (max 5%): about 9 picks, so no single stock can sink you. (The backtest held 20; owning fewer means bigger swings.)</div>
            <div><span className="font-medium text-slate-200">Backtest (2016–2026, S&amp;P 500, top 20 monthly):</span> the momentum & trend score made about 32%/yr vs 15% for SPY and 17% for all stocks equally, in both 5-year halves. FVG setups added nothing to picking. Real results will be lower: the test only includes today's index members, so it misses companies that collapsed. Earnings, quality and valuation couldn't be tested (no free history).</div>
          </div>
          <p className="text-xs text-slate-500">Score ≥ {L.HIGH_CONVICTION} = Top pick · {L.RECOMMEND}–{L.HIGH_CONVICTION - 1} = Recommended · {L.WATCH}–{L.RECOMMEND - 1} = Watchlist. A number we couldn't get counts as neutral (half credit) and the card says "Partial data". No method guarantees profits; this one leans on the signals with the best long-run track record.</p>
          <p className="text-xs text-slate-500">Every weekday the job scans every US stock worth $2B+ and priced $5+ (about 1,500–2,000), then fully checks about 400: your holdings and the momentum leaders every day, plus everything else in rotation, oldest check first. Full checks are kept for 7 days, so the whole market is covered about every 5 days. The site shows the ones scoring 50+ plus your holdings.</p>
        </div>
      )}
    </Card>
  );
}

function WatchRow({ s, onOpen }) {
  const h = HORIZON_INFO[s.horizon] || HORIZON_INFO.core;
  const first = s.buyPlan && s.buyPlan.steps[0];
  return (
    <tr onClick={() => onOpen(s.ticker)} className="cursor-pointer border-b border-slate-700/40 last:border-0 hover:bg-slate-700/30">
      <td className="px-4 py-2.5"><div className="font-semibold text-white">{s.ticker}</div><SectorChip sector={s.sector} /></td>
      <td className="px-3 py-2.5"><ScoreBadge score={s.composite} size="sm" /></td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{px(s.price)}</td>
      <td className="px-3 py-2.5 text-xs text-slate-300">{h.label}</td>
      <td className="px-3 py-2.5 text-xs"><span className={"rounded px-1.5 py-0.5 ring-1 " + RISK_STYLE[s.risk]}>{s.risk}</span></td>
      <td className={"px-3 py-2.5 text-right tabular-nums " + tone(s.factors && s.factors.mom12_1)}>{spct(s.factors && s.factors.mom12_1, 0)}</td>
      <td className="px-3 py-2.5 text-xs text-slate-300">{first ? "Buy now" : "—"}</td>
    </tr>
  );
}

function MarketScan({ scan, byTicker, onOpen }) {
  const [view, setView] = useState("movers");
  const [more, setMore] = useState(false);
  if (!scan) {
    return (
      <Card className="p-4 text-sm text-slate-400">
        <div className="flex items-center gap-2 font-semibold text-white"><Icon name="Radar" size={16} className="text-indigo-300" />Market scan</div>
        <p className="mt-1">The daily job scans every US stock worth $2B+ (about 1,500–2,000) for momentum, trend and FVG setups. Results show here after the first run.</p>
      </Card>
    );
  }
  const items = scan.items || [];
  const list = view === "movers"
    ? items.filter((r) => !r.fund && r.ret20 != null && r.price >= 5).sort((a, b) => b.ret20 - a.ret20)
    : view === "leaders"
      ? items.filter((r) => !r.fund && r.mom12_1 != null && r.price >= 5).sort((a, b) => (b.momRank12 ?? 0) + (b.above200 ? 0.2 : 0) - ((a.momRank12 ?? 0) + (a.above200 ? 0.2 : 0)))
      : items.filter((r) => !r.fund && r.fvgStatus !== "None").sort((a, b) => (b.entryLive - a.entryLive) || (b.tech - a.tech) || ((b.ret20 || 0) - (a.ret20 || 0)));
  const rows = list.slice(0, more ? 75 : 15);
  const live = items.filter((r) => r.entryLive).length;
  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Radar" size={18} className="text-indigo-400" />Market scan</h2>
          <p className="text-sm text-slate-400">{scan.scanned} stocks scanned on {fmtDate((scan.generatedAt || "").slice(0, 10))} · {items.filter((r) => r.fvgStatus !== "None").length} with a bullish FVG · {live} live entries. Highlighted rows got a full check today; {scan.fullyChecked || "—"} stocks have one from the last week.</p>
        </div>
        <Segmented label="Scan view" value={view} onChange={(v) => { setView(v); setMore(false); }}
          options={[{ value: "movers", label: "Top movers (1 mo)", icon: "Rocket" }, { value: "leaders", label: "Momentum leaders (12 mo)", icon: "TrendingUp" }, { value: "setups", label: "FVG setups", icon: "Crosshair" }]} />
      </div>
      <Card className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[840px] text-sm">
          <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 text-right font-medium">Price</th>
            <th className="px-3 py-2.5 text-right font-medium">1 week</th><th className="px-3 py-2.5 text-right font-medium">1 month</th>
            <th className="px-3 py-2.5 text-right font-medium">3 months</th><th className="px-3 py-2.5 text-right font-medium">12-1 mo</th><th className="px-3 py-2.5 text-right font-medium">Volume vs avg</th>
            <th className="px-3 py-2.5 text-right font-medium">From 52w high</th><th className="px-3 py-2.5 font-medium">Setup</th><th className="px-3 py-2.5 font-medium">Score</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const s = byTicker[r.ticker];
              return (
                <tr key={r.ticker} onClick={s ? () => onOpen(r.ticker) : undefined}
                  className={"border-b border-slate-700/40 last:border-0 " + (s ? "cursor-pointer bg-indigo-500/5 hover:bg-indigo-500/10" : "")}>
                  <td className="px-4 py-2.5"><div className="font-semibold text-white">{r.ticker}</div><div className="max-w-[12rem] truncate text-xs text-slate-500">{r.name}</div></td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{px(r.price)}</td>
                  <td className={"px-3 py-2.5 text-right tabular-nums " + tone(r.ret5)}>{spct(r.ret5)}</td>
                  <td className={"px-3 py-2.5 text-right font-medium tabular-nums " + tone(r.ret20)}>{spct(r.ret20)}</td>
                  <td className={"px-3 py-2.5 text-right tabular-nums " + tone(r.ret60)}>{spct(r.ret60)}</td>
                  <td className={"px-3 py-2.5 text-right tabular-nums " + tone(r.mom12_1)} title={r.above200 == null ? "" : r.above200 ? "Above its 200-day average" : "Below its 200-day average"}>{spct(r.mom12_1, 0)}{r.above200 === false && <span className="ml-1 text-[10px] text-rose-400">▼200d</span>}</td>
                  <td className={"px-3 py-2.5 text-right tabular-nums " + (r.volRatio >= 1.5 ? "text-emerald-300" : "text-slate-300")}>{r.volRatio != null ? r.volRatio.toFixed(1) + "x" : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{spct(r.fromHigh)}</td>
                  <td className="px-3 py-2.5">
                    {r.fvgStatus === "None" ? <span className="text-xs text-slate-500">—</span>
                      : <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + (r.entryLive ? "bg-emerald-500 text-slate-900" : r.fvgStatus === "Rejected" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300")}>
                          {r.entryLive ? "Entry live" : r.fvgTf + " " + r.fvgStatus.toLowerCase()}
                        </span>}
                  </td>
                  <td className="px-3 py-2.5">{s ? <ScoreBadge score={s.composite} size="sm" /> : <span className="text-xs text-slate-500">chart only</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="p-6 text-center text-sm text-slate-400">Nothing to show for this view today.</div>}
      </Card>
      {list.length > 15 && (
        <button type="button" onClick={() => setMore(!more)} className="mt-2 text-xs font-medium text-indigo-300 hover:text-indigo-200">
          {more ? "Show fewer" : "Show " + Math.min(75, list.length) + " of " + list.length}
        </button>
      )}
    </div>
  );
}

/**
 * Freeze the page behind a popup (incl. iPhone Safari, which ignores overflow:hidden on body): pin the body in place
 * and put the scroll position back when the popup closes.
 */
function useScrollLock(active = true) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const b = document.body, y = window.scrollY;
    const prev = { position: b.style.position, top: b.style.top, width: b.style.width, overflow: b.style.overflow };
    Object.assign(b.style, { position: "fixed", top: -y + "px", width: "100%", overflow: "hidden" });
    return () => { Object.assign(b.style, prev); window.scrollTo(0, y); };
  }, [active]);
}

/** True on screens 768px+ (md). Lets big lists render one layout instead of hiding a second copy with CSS. */
function useIsDesktop() {
  const q = "(min-width: 768px)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : true);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q), f = () => setOn(m.matches);
    m.addEventListener ? m.addEventListener("change", f) : m.addListener(f);
    return () => (m.removeEventListener ? m.removeEventListener("change", f) : m.removeListener(f));
  }, []);
  return on;
}

function MoreButton({ shown, total, onMore }) {
  if (shown >= total) return null;
  return (
    <div className="mt-3 text-center">
      <button type="button" onClick={onMore} className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700">Show more ({total - shown} left)</button>
    </div>
  );
}

function Picks({ scored, byTicker, scan, onOpen }) {
  const [sort, setSort] = useState("composite");
  const [lim, setLim] = useState({ top: 12, mid: 12, watch: 30 });
  const more = (k, n) => setLim((x) => ({ ...x, [k]: x[k] + n }));
  const [horizon, setHorizon] = useState("all");
  const [risk, setRisk] = useState("all");
  const fits = (s) => (horizon === "all" || s.horizon === horizon) && (risk === "all" || s.risk === risk);
  // Within a horizon tab, rank by that horizon's fit; otherwise by the chosen factor.
  const order = (list) => list.slice().sort((a, b) => (sort === "composite" && horizon !== "all" ? b.fits[horizon] - a.fits[horizon] : b[sort] - a[sort]) || b.composite - a.composite);
  const qualified = scored.filter((s) => s.composite >= L.RECOMMEND);
  const top = order(scored.filter((s) => s.composite >= L.HIGH_CONVICTION && fits(s)));
  const mid = order(scored.filter((s) => s.composite >= L.RECOMMEND && s.composite < L.HIGH_CONVICTION && fits(s)));
  const watch = order(scored.filter((s) => s.composite >= L.WATCH && s.composite < L.RECOMMEND && fits(s)));
  const n = (h) => qualified.filter((s) => s.horizon === h).length;
  const buyNow = qualified.filter((s) => s.buyPlan).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Top picks" value={qualified.filter((s) => s.composite >= L.HIGH_CONVICTION).length} sub={"score ≥ " + L.HIGH_CONVICTION + " · " + qualified.length + " recommended"} icon="Award" />
        <Stat label="By horizon" value={n("core") + " · " + n("long")} sub="core (3–12 mo) · long-term (1–3+ yr)" icon="CalendarRange" />
        <Stat label="Buyable now" value={buyNow} sub="recommended · buy all at once" valueTone="up" icon="ShoppingCart" />
        <Stat label="Fully checked" value={scan && scan.fullyChecked ? scan.fullyChecked : scored.length} sub={scan ? "of " + scan.scanned + " scanned · " + scored.length + " score 50+" : "fully checked"} icon="ScanSearch" />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          <Segmented options={HORIZONS} value={horizon} onChange={setHorizon} label="Filter by horizon" />
          <Segmented options={RISKS} value={risk} onChange={setRisk} label="Filter by risk" />
        </div>
        <div className="flex items-center gap-2"><span className="hidden text-xs text-slate-400 xl:inline">Sort by</span><Segmented options={SORTS} value={sort} onChange={setSort} label="Sort picks" /></div>
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Award" size={18} className="text-indigo-400" />Top Picks<span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-xs font-semibold text-indigo-300">{L.HIGH_CONVICTION}+</span></h2>
        <p className="mb-3 text-sm text-slate-400">Strong on most of the five factors at once: the best-backed ideas right now.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {top.slice(0, lim.top).map((s) => <InvestmentCard key={s.ticker} s={s} onOpen={onOpen} />)}
        </div>
        <MoreButton shown={lim.top} total={top.length} onMore={() => more("top", 12)} />
        {top.length === 0 && <Card className="p-6 text-center text-sm text-slate-400">No top picks match these filters right now.</Card>}
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Layers" size={18} className="text-emerald-400" />Recommended<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">{L.RECOMMEND}–{L.HIGH_CONVICTION - 1}</span></h2>
        <p className="mb-3 text-sm text-slate-400">Good overall, with one or two weaker factors (see the bars on each card).</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {mid.slice(0, lim.mid).map((s) => <InvestmentCard key={s.ticker} s={s} onOpen={onOpen} />)}
        </div>
        <MoreButton shown={lim.mid} total={mid.length} onMore={() => more("mid", 12)} />
        {mid.length === 0 && <Card className="p-6 text-center text-sm text-slate-400">Nothing in this band matches these filters.</Card>}
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Eye" size={18} className="text-amber-300" />Watchlist<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">{L.WATCH}–{L.RECOMMEND - 1}</span></h2>
        <p className="mb-3 text-sm text-slate-400">Close, but not there yet. Click a row for the full breakdown and buy plan.</p>
        {watch.length > 0 ? (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 font-medium">Score</th><th className="px-3 py-2.5 text-right font-medium">Price</th>
                <th className="px-3 py-2.5 font-medium">Horizon</th><th className="px-3 py-2.5 font-medium">Risk</th><th className="px-3 py-2.5 text-right font-medium">12-mo momentum</th><th className="px-3 py-2.5 font-medium">Plan</th>
              </tr></thead>
              <tbody>{watch.slice(0, lim.watch).map((s) => <WatchRow key={s.ticker} s={s} onOpen={onOpen} />)}</tbody>
            </table>
          </Card>
        ) : <Card className="p-6 text-center text-sm text-slate-400">No stocks in this band right now.</Card>}
        {watch.length > 0 && <MoreButton shown={lim.watch} total={watch.length} onMore={() => more("watch", 50)} />}
        <p className="mt-3 text-xs text-slate-500">Stocks scoring below {L.WATCH} are hidden.</p>
      </div>

      <MarketScan scan={scan} byTicker={byTicker} onOpen={onOpen} />
      <Methodology />
    </div>
  );
}


/* ===================== Tab: Short-term Trades ===================== */
const SHORT_BUDGET = 0.22; // share of the portfolio for short-term trades (you chose ~20-25%)
const todayISO = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

function SetupStats({ st }) {
  if (!st) return <span className="text-xs text-amber-300">Experimental: still being tested</span>;
  return (
    <span className="text-xs text-slate-400">
      10-yr backtest: <span className="font-semibold text-emerald-300">{spct(st.avg)}</span> per trade ({spct(st.vsSpy)} vs SPY) · wins {Math.round(st.win * 100)}% · worst drop {Math.round(st.maxDD * 100)}%
    </span>
  );
}

/** Pass/fail line for one rule a short-term setup checks. */
function RuleRow({ ok, label, value }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon name={ok ? "CheckCircle2" : "Circle"} size={15} className={"mt-0.5 shrink-0 " + (ok ? "text-emerald-400" : "text-slate-500")} />
      <span className="text-slate-300">{label}{value != null && <span className="ml-1 font-semibold tabular-nums text-white">{value}</span>}</span>
    </div>
  );
}

function shortRules(x, k) {
  const g = x.facts && x.facts.gapSig;
  const f = x.facts, p = x.price;
  const vs = (m) => (m ? spct(p / m - 1, 0) : "n/a");
  const common = [
    { ok: (f.dollarVol || 0) >= 5e6, label: "Heavily traded (easy to buy and sell):", value: "$" + Math.round((f.dollarVol || 0) / 1e6) + "M a day" },
  ];
  if (k === "momentum") return [
    { ok: true, label: "One of the 20 biggest 1-month gainers out of ~2,000 stocks:", value: spct(f.ret21, 0) + " in a month" },
    { ok: f.sma50 && p > f.sma50, label: "Still above its 50-day average (trend intact):", value: vs(f.sma50) },
    ...common,
  ];
  if (k === "gap") return [
    { ok: !!g, label: "Opened 4%+ above the day before" + (g ? " on " + fmtDate(g.date) + ":" : ":"), value: g ? spct(g.gap, 1) : "n/a" },
    { ok: !!g && g.volX >= 3, label: "Volume at least 3x normal that day (real news, big buyers):", value: g ? g.volX.toFixed(1) + "x" : "n/a" },
    { ok: !!g, label: g && g.daysAgo > 0 ? "Still in the 5-day buy window (" + (5 - g.daysAgo) + " trading day" + (5 - g.daysAgo === 1 ? "" : "s") + " left; buying late worked about as well in the test)" : "Jumped today: buy tomorrow or within 5 trading days" },
    { ok: true, label: "Held the gain into the close (didn't fade)" },
    { ok: f.sma200 && p > f.sma200, label: "Above its 200-day average (long uptrend):", value: vs(f.sma200) },
    ...common,
  ];
  return common;
}

function ShortModal({ x, setupKey, byTicker, total, today, owned, onBuy, onClose, onOpenLong }) {
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    if (ref.current) { ref.current.scrollTop = 0; ref.current.focus({ preventScroll: true }); }
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useScrollLock(true);
  const S = SETUPS[setupKey], st = S.stats, f = x.facts;
  const plan = tradePlanFor(setupKey, x.price, f, { total, budgetPct: SHORT_BUDGET, earningsDate: x.earningsDate, today });
  const full = byTicker[x.ticker];
  const dailyMove = f.atr && x.price ? f.atr / x.price : null;
  const swing = plan.size && dailyMove ? plan.size * dailyMove : null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={x.ticker + " short-term trade"} onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] supports-[height:100dvh]:max-h-[92dvh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-2xl border border-slate-700 bg-slate-800 p-5 shadow-2xl focus:outline-none sm:rounded-2xl">
        <div style={{ top: "-1.25rem", marginTop: "-1.25rem" }} className="sticky z-10 -mx-5 flex items-start justify-between gap-3 border-b border-slate-700/60 bg-slate-800 px-5 pb-3 pt-5">
          <div>
            <div className="flex items-baseline gap-2"><span className="text-xl font-bold text-white">{x.ticker}</span><span className="tabular-nums text-slate-300">{px(x.price)}</span></div>
            <div className="text-sm text-slate-400">{x.name} · {x.sector}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">{S.label}</span>
              <span className="rounded-md bg-slate-700 px-2 py-0.5 text-xs text-slate-300">hold {S.span}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white"><Icon name="X" size={18} /></button>
        </div>

        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why it's on the list</div>
          <p className="mt-1 text-sm text-slate-400">{S.blurb}</p>
          <div className="mt-2 space-y-1.5">{shortRules(x, setupKey).map((r) => <RuleRow key={r.label} {...r} />)}</div>
        </div>

        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">The plan</div>
          <div className="mt-1.5 space-y-1 text-sm text-slate-300">
            <div><span className="text-slate-500">Buy:</span> {plan.size ? <span className="font-semibold text-white">~{usd(plan.size)}</span> : "1/8 of your short-term budget"} now, around {px(x.price)}</div>
            <div><span className="text-slate-500">Sell:</span> <span className="font-semibold text-white">{fmtDate(plan.sellBy)}</span>, whatever the price. Don't hold longer hoping for more.</div>
            <div><span className="text-slate-500">Sell early only if:</span> something truly serious (fraud, bankruptcy). A big drop alone isn't a reason: selling after drops did worse in the test, and so did every stop-loss.</div>
            {dailyMove != null && <div><span className="text-slate-500">Expect:</span> it usually moves about ±{Math.round(dailyMove * 1000) / 10}% a day{swing ? " (~" + usd(swing) + " on your position)" : ""}. Normal, don't panic-sell.</div>}
          </div>
          {plan.earnings && <div className="mt-2 flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300"><Icon name="CalendarClock" size={13} />Earnings {fmtDate(plan.earnings.date)} ({plan.earnings.days} days) falls inside the hold: a big jump or drop is possible that day.</div>}
        </div>

        {st && (
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">What happened in 10 years of tests</div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Avg trade", spct(st.avg, 1)], ["Beat SPY by", spct(st.vsSpy, 1)], ["Trades that won", Math.round(st.win * 100) + "%"], ["Worst drop", Math.round(st.maxDD * 100) + "%"]].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-slate-900/60 px-2.5 py-2"><div className="text-[11px] text-slate-500">{k}</div><div className="font-semibold tabular-nums text-white">{v}</div></div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">It's a numbers game: about half the trades lose, but the winners are bigger. One trade proves nothing; the edge shows up over many.</p>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 text-sm text-slate-300">
          <div className="font-medium text-indigo-200">How this differs from long-term</div>
          <p className="mt-1">Long-term picks are about the business: earnings growth, quality, value, analysts. Over a few weeks those barely move a stock, so short-term only looks at <span className="text-white">price and volume</span>: is a strong move likely to keep going? {setupKey === "momentum" ? "Already up a lot? That's the signal, not a problem: in the test, buying after the big month still beat SPY over the next 4 weeks." : "Already jumped? That's the signal: after big news gaps, stocks kept drifting up for weeks in the test."}</p>
        </div>

        {full ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-900/50 p-3">
            <div className="flex items-center gap-2 text-sm text-slate-300"><ScoreBadge score={full.composite} size="sm" /><span>Long-term score {Math.round(full.composite)}, {(full.risk || "").toLowerCase()} risk</span></div>
            <button type="button" onClick={() => onOpenLong(x.ticker)} className="text-sm text-indigo-300 hover:text-indigo-200">Long-term breakdown →</button>
          </div>
        ) : <p className="mt-4 text-xs text-slate-500">Not fully checked on the long-term side yet. That's fine: this trade doesn't depend on it.</p>}
        {full && (full.newsFlags || []).length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">Headlines to check before buying</div>
            <ul className="mt-1 space-y-0.5">{full.newsFlags.map((n) => <li key={n.headline} className="text-xs text-slate-300">• {n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline">{n.headline}</a> : n.headline}</li>)}</ul>
          </div>
        )}

        <div className="mt-4">
          {owned ? <span className="inline-flex items-center gap-1 text-sm text-emerald-300"><Icon name="Check" size={14} />In your open trades</span>
            : <button type="button" onClick={() => { onBuy({ ticker: x.ticker, setup: setupKey, date: todayISO(), price: x.price, sellBy: plan.sellBy, sma5: f.sma5 || null }); onClose(); }}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-emerald-400">I bought this</button>}
        </div>
      </div>
    </div>
  );
}

function ShortCard({ x, setupKey, byTicker, total, today, onBuy, owned, onOpen, onDetails }) {
  const plan = tradePlanFor(setupKey, x.price, x.facts, { total, budgetPct: SHORT_BUDGET, earningsDate: x.earningsDate, today });
  const full = byTicker[x.ticker];
  const why = setupKey === "momentum" ? "Up " + spct(x.facts.ret21, 0) + " in a month"
    : setupKey === "gap" ? (x.facts.gapSig ? "Gapped up " + spct(x.facts.gapSig.gap, 1) + " on " + x.facts.gapSig.volX.toFixed(1) + "x volume " + (x.facts.gapSig.daysAgo ? fmtDate(x.facts.gapSig.date) + " · buy window: " + (5 - x.facts.gapSig.daysAgo) + " more day" + (5 - x.facts.gapSig.daysAgo === 1 ? "" : "s") : "today") : "Gapped up " + spct(x.facts.gapToday, 1))
    : "RSI-2 at " + Math.round(x.facts.rsi2 || 0) + " after a pullback";
  return (
    <div className="flex flex-col rounded-xl border border-slate-700/60 bg-slate-800 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onDetails} className="min-w-0 text-left">
          <div className="flex items-baseline gap-2"><span className="text-base font-bold text-white hover:underline">{x.ticker}</span><span className="text-sm tabular-nums text-slate-300">{px(x.price)}</span></div>
          <div className="truncate text-xs text-slate-400">{x.name}</div>
        </button>
        {full ? <button type="button" onClick={() => onOpen(x.ticker)} title="Long-term score: open the full breakdown"><ScoreBadge score={full.composite} size="sm" /></button> : null}
      </div>
      <div className="mt-2 text-sm text-emerald-300">{why}</div>
      {plan.earnings && <div className="mt-1.5 flex items-center gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300"><Icon name="CalendarClock" size={12} />Earnings {fmtDate(plan.earnings.date)} ({plan.earnings.days} days): a big move either way is possible</div>}
      <div className="mt-2 space-y-0.5 text-xs text-slate-300">
        <div><span className="text-slate-500">Buy:</span> {plan.size ? <span className="font-semibold text-white">~{usd(plan.size)}</span> : Math.round(plan.sizePct * 1000) / 10 + "% of portfolio"} now (~{px(x.price)})</div>
        <div><span className="text-slate-500">Sell:</span> {setupKey === "dip" ? "first close above the 5-day avg (~" + px(x.facts.sma5) + "), max 10 days" : "on " + fmtDate(plan.sellBy)}</div>
        <div><span className="text-slate-500">Early exit:</span> only for something truly serious (drops and stop-losses tested worse)</div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-2.5">
        {owned ? <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><Icon name="Check" size={13} />In your open trades</span>
          : <button type="button" onClick={() => onBuy({ ticker: x.ticker, setup: setupKey, date: todayISO(), price: x.price, sellBy: plan.sellBy, sma5: x.facts.sma5 || null })}
              className="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10">I bought this</button>}
        <button type="button" onClick={onDetails} className="text-xs text-indigo-300 hover:text-indigo-200">Why + details →</button>
      </div>
    </div>
  );
}

function OpenTrades({ trades, priceBook, onClose, byTicker = {} }) {
  if (!trades.length) return null;
  const today = todayISO();
  return (
    <Card className="overflow-x-auto">
      <div className="px-4 pt-3 text-sm font-semibold text-white">My open short-term trades</div>
      <table className="mt-2 w-full min-w-[640px] text-sm">
        <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
          <th className="px-4 py-2 font-medium">Trade</th><th className="px-3 py-2 text-right font-medium">Bought</th><th className="px-3 py-2 text-right font-medium">Now</th><th className="px-3 py-2 text-right font-medium">P/L</th><th className="px-3 py-2 font-medium">What to do</th><th className="px-3 py-2" />
        </tr></thead>
        <tbody>
          {trades.slice().sort((a, b) => (a.sellBy || "").localeCompare(b.sellBy || "")).map((t) => {
            const now = priceBook[t.ticker] ? priceBook[t.ticker].price : null;
            const pl = now ? now / t.price - 1 : null;
            const daysLeft = t.sellBy ? Math.round((Date.parse(t.sellBy) - Date.parse(today)) / 864e5) : null;
            const st = byTicker[t.ticker];
            const upd = st && st.upd && (Date.parse(today) - Date.parse(st.upd.date)) / 864e5 <= 3 ? st.upd : null;
            const badNews = upd && upd.events.find((e) => e.text.startsWith("Headline"));
            const status = badNews && !(daysLeft != null && daysLeft <= 0) ? ["Headline: read it, but hold unless it's serious", "bg-amber-500 text-slate-900"]
              : t.setup === "dip" && now && t.sma5 && now > t.sma5 ? ["Sell: bounced above the 5-day", "bg-emerald-500 text-slate-900"]
              : daysLeft != null && daysLeft <= 0 ? ["Sell today: time's up", "bg-amber-500 text-slate-900"]
              : ["Hold · sell " + fmtDate(t.sellBy) + " (" + daysLeft + "d)", "bg-slate-700 text-slate-200"];
            return (
              <tr key={t.id} className="border-b border-slate-700/40 last:border-0">
                <td className="px-4 py-2.5"><div className="font-semibold text-white">{t.ticker}</div><div className="text-xs text-slate-400">{(SETUPS[t.setup] || {}).label} · {fmtDate(t.date)}</div>{upd && upd.events.length > 0 && <div className={"max-w-[18rem] truncate text-[11px] " + (upd.tone === "bad" ? "text-rose-300" : upd.tone === "good" ? "text-emerald-300" : "text-slate-400")} title={upd.events.map((e) => e.text).join("\n")}>Update: {upd.events.map((e) => e.text).join(" · ")}</div>}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{px(t.price)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{now ? px(now) : "—"}</td>
                <td className={"px-3 py-2.5 text-right tabular-nums " + tone(pl)}>{pl == null ? "—" : spct(pl)}</td>
                <td className="px-3 py-2.5"><span className={"rounded-md px-2 py-0.5 text-xs font-semibold " + status[1]}>{status[0]}</span></td>
                <td className="px-3 py-2.5 text-right"><button type="button" onClick={() => onClose(t.id)} className="text-xs text-slate-400 hover:text-white" title="Remove once you've sold">Sold / remove</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 pb-3 pt-1 text-xs text-slate-500">Prices update after each nightly run. Syncs to your other devices if sync is on.</p>
    </Card>
  );
}

function ShortTermTab({ data, byTicker, priceBook, pf, total, onOpen }) {
  const [showOut, setShowOut] = useState(false);
  const [showAll, setShowAll] = useState({});
  const [detail, setDetail] = useState(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const items = (data && data.items) || [];
  const today = data && data.generatedAt ? data.generatedAt.slice(0, 10) : todayISO();
  const owned = new Set(pf.trades.map((t) => t.ticker));
  const lists = {
    momentum: items.filter((x) => x.setups.includes("momentum")).sort((a, b) => (b.facts.ret21 || 0) - (a.facts.ret21 || 0)),
    gap: items.filter((x) => x.setups.includes("gap")).sort((a, b) => ((a.facts.gapSig || {}).daysAgo ?? 9) - ((b.facts.gapSig || {}).daysAgo ?? 9) || ((b.facts.gapSig || {}).gap || 0) - ((a.facts.gapSig || {}).gap || 0)),
    dip: items.filter((x) => x.setups.includes("dip")).sort((a, b) => (b.rank6 || 0) - (a.rank6 || 0)).slice(0, 12),
  };
  const budget = total * SHORT_BUDGET;
  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Zap" size={18} className="text-amber-300" />Short-term trades</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">Only setups that beat simply holding SPY in a 10-year backtest. They use <span className="text-slate-200">time-based exits</span> (tested better than tight stops or profit targets): buy, then sell on the date shown. Expect lots of small losses mixed with bigger wins; about half of trades win.</p>
          </div>
          <div className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
            <div className="text-slate-400">Short-term budget (~{Math.round(SHORT_BUDGET * 100)}%)</div>
            <div className="font-semibold text-white">{total ? usd(budget) : "add holdings to see $"}</div>
            <div className="text-xs text-slate-500">up to 8 trades{total ? " · ~" + usd(budget / 8) + " each" : ""}</div>
          </div>
        </div>
      </Card>

      <OpenTrades trades={pf.trades} priceBook={priceBook} onClose={pf.closeTrade} byTicker={byTicker} />
      {detail && <ShortModal x={detail.x} setupKey={detail.k} byTicker={byTicker} total={total} today={today} owned={owned.has(detail.x.ticker)} onBuy={pf.addTrade}
        onClose={closeDetail} onOpenLong={(t) => { setDetail(null); onOpen(t); }} />}

      {!data && <Card className="p-6 text-center text-sm text-slate-400">Short-term setups appear after the next nightly run.</Card>}
      {data && ["momentum", "gap", "dip"].filter((k) => SETUPS[k] && !SETUPS[k].disabled).map((k) => (
        <div key={k}>
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-white">{SETUPS[k].label}<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-medium text-slate-300">hold {SETUPS[k].span}</span>{SETUPS[k].experimental && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">experimental</span>}</h3>
          <p className="mt-0.5 text-sm text-slate-400">{SETUPS[k].blurb} {SETUPS[k].rule}</p>
          <div className="mb-3 mt-1"><SetupStats st={SETUPS[k].stats} /></div>
          {lists[k].length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(showAll[k] ? lists[k] : lists[k].slice(0, 8)).map((x) => <ShortCard key={k + x.ticker} x={x} setupKey={k} byTicker={byTicker} total={total} today={today} owned={owned.has(x.ticker)} onBuy={pf.addTrade} onOpen={onOpen} onDetails={() => setDetail({ x, k })} />)}
            </div>
          ) : <Card className="p-4 text-center text-sm text-slate-400">No {SETUPS[k].label.toLowerCase()} setups today.</Card>}
          {lists[k].length > 8 && <button type="button" onClick={() => setShowAll({ ...showAll, [k]: !showAll[k] })} className="mt-2 text-sm text-indigo-300 hover:text-indigo-200">{showAll[k] ? "Show top 8 only" : "Show all " + lists[k].length + " (top 8 are the strongest)"}</button>}
        </div>
      ))}

      <Card className="overflow-hidden">
        <button type="button" onClick={() => setShowOut(!showOut)} aria-expanded={showOut} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-700/40">
          <span className="flex items-center gap-2"><Icon name="FlaskConical" size={15} className="text-indigo-300" />What the backtest ruled out, and the fine print</span>
          <Icon name="ChevronDown" size={16} className={"transition " + (showOut ? "rotate-180" : "")} />
        </button>
        {showOut && (
          <div className="space-y-2 border-t border-slate-700/60 px-4 py-3 text-sm">
            {RULED_OUT.map(([k, d]) => <div key={k}><span className="font-medium text-slate-100">{k}:</span> <span className="text-slate-400">{d}</span></div>)}
            <p className="text-xs text-slate-500">Backtest: 2016–2026, US stocks worth $2B+, buy at the next day's open, 0.1% cost per side. It only includes stocks listed today (companies that collapsed are missing), so real results will be lower. Each trade is 1/8 of the short-term budget so no single trade can do much damage. Not financial advice.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

/* =================== Tab 2: Analyst & Insider Intelligence =================== */
const ACTION_STYLE = {
  Upgrade: ["bg-emerald-500/15 text-emerald-300 ring-emerald-500/30", "ArrowUpCircle"],
  Downgrade: ["bg-rose-500/15 text-rose-300 ring-rose-500/30", "ArrowDownCircle"],
  "PT Raise": ["bg-emerald-500/10 text-emerald-300 ring-emerald-500/20", "TrendingUp"],
  "PT Cut": ["bg-rose-500/10 text-rose-300 ring-rose-500/20", "TrendingDown"],
  Initiate: ["bg-indigo-500/15 text-indigo-300 ring-indigo-500/30", "Sparkles"],
  Reiterate: ["bg-slate-600/40 text-slate-300 ring-slate-500/30", "RefreshCw"],
};
const ACTIONS = ["All", "Upgrade", "Downgrade", "PT Raise", "PT Cut", "Initiate", "Reiterate"];

function ActionPill({ action }) {
  const st = ACTION_STYLE[action] || ACTION_STYLE.Reiterate;
  return <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 " + st[0]}><Icon name={st[1]} size={12} />{action}</span>;
}

function TargetShift({ a }) {
  if (a.newTarget == null) return <span className="text-xs text-slate-500">No PT change reported</span>;
  if (a.oldTarget == null) return <span className="whitespace-nowrap tabular-nums text-slate-200">{a.action === "Initiate" ? "New" : "PT"} · {px(a.newTarget)}</span>;
  const ch = (a.newTarget - a.oldTarget) / a.oldTarget;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-slate-400">{px(a.oldTarget)}</span><Icon name="ArrowRight" size={12} className="mx-1 inline text-slate-500" />
      <span className="font-medium text-slate-100">{px(a.newTarget)}</span><span className={"ml-1.5 text-xs " + tone(ch)}>{spct(ch)}</span>
    </span>
  );
}

function SourceBadge({ href, label, title }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-sky-300 ring-1 ring-slate-600 hover:bg-slate-700 hover:text-sky-200">
      <Icon name="Newspaper" size={12} />{label}<Icon name="ExternalLink" size={11} />
    </a>
  );
}
const articleUrl = (a) => a.url || (SOURCE_URLS[a.source] ? SOURCE_URLS[a.source](a.ticker) : "#");

function LiveBar({ res, label, onRefresh }) {
  const t = res.lastUpdated ? res.lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-300"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>{label}</span>
      <span>Updated {t}{res.loading ? " · syncing…" : ""}</span>
      <span className={res.source === "mock" ? "text-amber-300" : "text-emerald-300"}>{SOURCE_LABEL[res.source] || res.source}</span>
      {res.notes && res.notes.length > 0 && <span className="text-slate-500">{res.notes[0]}</span>}
      {res.error && <span className="text-rose-400">{res.error}</span>}
      <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-700"><Icon name="RefreshCw" size={12} />Refresh</button>
    </div>
  );
}

function InsiderPanel({ scored, txRes }) {
  const [filter, setFilter] = useState("all");
  const [hidePlanned, setHidePlanned] = useState(false);
  const [shownTx, setShownTx] = useState(50);
  useEffect(() => setShownTx(50), [filter, hidePlanned]);
  const items = txRes.data.items;
  const names = scored.filter((s) => s.insider.net !== 0).sort((a, b) => b.insider.net - a.insider.net);
  const buyers = names.filter((s) => s.insider.net > 0), sellers = names.filter((s) => s.insider.net < 0).reverse();
  const maxBuy = Math.max(1, ...buyers.map((s) => s.insider.net)), maxSell = Math.max(1, ...sellers.map((s) => -s.insider.net));
  const rows = items
    .filter((t) => filter === "all" || (filter === "buy" ? t.value > 0 : t.value < 0))
    .filter((t) => !(hidePlanned && t.planned))
    .slice().sort((a, b) => b.date.localeCompare(a.date));
  const discretionarySells = items.filter((t) => t.value < 0 && !t.planned).reduce((a, t) => a - t.value, 0);

  const List = ({ list, max, buy }) => (
    <div className="space-y-2">
      {list.map((s) => (
        <div key={s.ticker} className="grid grid-cols-[3.5rem_1fr_4.5rem] items-center gap-2 text-sm">
          <span className="font-semibold text-white">{s.ticker}</span>
          <div className="h-2 rounded-full bg-slate-700/70"><div className={"h-2 rounded-full " + (buy ? "bg-emerald-500" : "bg-rose-500")} style={{ width: Math.max(3, (Math.abs(s.insider.net) / max) * 100) + "%" }} /></div>
          <span className={"text-right tabular-nums " + (buy ? "text-emerald-400" : "text-rose-400")}>{compact(s.insider.net)}</span>
        </div>
      ))}
      {list.length === 0 && <div className="text-sm text-slate-500">None in window</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="UserCheck" size={18} className="text-indigo-400" />Net Insider Activity<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">90 days</span></h2>
        <p className="text-sm text-slate-400">Open-market Form 4 trades by executives, directors and 10% owners. Buying with personal cash is the stronger signal; pre-planned 10b5-1 sales are mostly routine.</p>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><Icon name="ArrowUpRight" size={15} />Net buyers ({buyers.length})</span><span className="text-xs tabular-nums text-slate-400">{compact(buyers.reduce((a, s) => a + s.insider.net, 0))} total</span></div>
          <List list={buyers} max={maxBuy} buy />
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold text-rose-300"><Icon name="ArrowDownRight" size={15} />Net sellers ({sellers.length})</span><span className="text-xs tabular-nums text-slate-400">{compact(-discretionarySells)} discretionary</span></div>
          <List list={sellers} max={maxSell} buy={false} />
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="text-sm font-semibold text-white">Form 4 transactions</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={hidePlanned} onChange={(e) => setHidePlanned(e.target.checked)} className="accent-indigo-500" />Hide 10b5-1 planned</label>
            <Segmented label="Filter insider trades" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "buy", label: "Buys" }, { value: "sell", label: "Sells" }]} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-y border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Date</th><th className="px-3 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 font-medium">Insider role</th>
              <th className="px-3 py-2.5 font-medium">Type</th><th className="px-3 py-2.5 text-right font-medium">Shares</th><th className="px-3 py-2.5 text-right font-medium">Value</th><th className="px-4 py-2.5 font-medium">Filing</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, shownTx).map((t, i) => (
                <tr key={t.date + t.ticker + i} className="border-b border-slate-700/40 last:border-0 hover:bg-slate-700/25">
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">{fmtDate(t.date)}</td>
                  <td className="px-3 py-2.5 font-semibold text-white">{t.ticker}</td>
                  <td className="px-3 py-2.5 text-slate-300">{t.role}</td>
                  <td className="px-3 py-2.5">
                    <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + (t.value > 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>{t.value > 0 ? "Buy" : "Sell"}</span>
                    {t.planned && <span className="ml-1.5 text-[11px] text-slate-500">10b5-1</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{t.shares.toLocaleString("en-US")}</td>
                  <td className={"px-3 py-2.5 text-right font-medium tabular-nums " + tone(t.value)}>{compact(t.value)}</td>
                  <td className="px-4 py-2.5"><SourceBadge href={t.url || insiderSourceUrl(t.ticker)} label="SEC Form 4" title={"Open " + t.ticker + " Form 4 filings on SEC EDGAR"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="p-6 text-center text-sm text-slate-400">No insider trades match these filters.</div>}
        </div>
        <div className="pb-3"><MoreButton shown={shownTx} total={rows.length} onMore={() => setShownTx(shownTx + 50)} /></div>
      </Card>
    </div>
  );
}

function Intelligence({ scored, byTicker, feedRes, txRes, onOpen }) {
  const [action, setAction] = useState("All");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("date");
  const [shown, setShown] = useState(40); // the feed has thousands of rows: render a page at a time
  const desktop = useIsDesktop();
  useEffect(() => setShown(40), [action, q, sort]);
  const items = feedRes.data.items;
  const rows = useMemo(() => {
    let r = items.filter((a) => action === "All" || a.action === action);
    const qq = q.trim().toUpperCase();
    if (qq) r = r.filter((a) => a.ticker.includes(qq) || a.firm.toUpperCase().includes(qq));
    const d = (a) => (a.oldTarget ? Math.abs(a.newTarget - a.oldTarget) / a.oldTarget : 0);
    return r.slice().sort((a, b) => (sort === "date" ? b.date.localeCompare(a.date) : d(b) - d(a)));
  }, [items, action, q, sort]);
  const page = rows.slice(0, shown);
  const { counts, avgPt } = useMemo(() => {
    const counts = items.reduce((m, a) => ((m[a.action] = (m[a.action] || 0) + 1), m), {});
    const moves = items.filter((a) => a.oldTarget);
    return { counts, avgPt: moves.reduce((s, a) => s + (a.newTarget - a.oldTarget) / a.oldTarget, 0) / (moves.length || 1) };
  }, [items]);
  const netInsider = useMemo(() => txRes.data.items.reduce((a, t) => a + t.value, 0), [txRes.data]);
  const netBuyerCount = useMemo(() => scored.filter((s) => s.insider.net > 0).length, [scored]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Upgrades" value={counts.Upgrade || 0} sub={(counts["PT Raise"] || 0) + " target raises"} valueTone="up" icon="ArrowUpCircle" />
        <Stat label="Downgrades" value={counts.Downgrade || 0} sub={(counts["PT Cut"] || 0) + " target cuts"} valueTone="down" icon="ArrowDownCircle" />
        <Stat label="Avg PT revision" value={spct(avgPt)} sub={items.length + " rating actions"} valueTone={avgPt >= 0 ? "up" : "down"} icon="Scale" />
        <Stat label="Net insider flow" value={compact(netInsider)} sub={netBuyerCount + " names with net buying (90d)"} valueTone={netInsider >= 0 ? "up" : "down"} icon="UserCheck" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Radio" size={18} className="text-indigo-400" />Wall Street Rating Stream</h2>
            <LiveBar res={feedRes} label="Live stream" onRefresh={feedRes.refresh} />
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by action">
            {ACTIONS.map((a) => (
              <button key={a} type="button" onClick={() => setAction(a)} aria-pressed={action === a}
                className={"rounded-full px-3 py-1 text-xs font-medium ring-1 transition " + (action === a ? "bg-indigo-500 text-white ring-indigo-400" : "bg-slate-800 text-slate-300 ring-slate-700 hover:bg-slate-700")}>
                {a}{a !== "All" && counts[a] ? <span className="ml-1 opacity-70">{counts[a]}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search ticker or firm</span>
              <Icon name="Search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker or firm" className="w-44 rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
            </label>
            <Segmented label="Sort feed" value={sort} onChange={setSort} options={[{ value: "date", label: "Newest", icon: "Clock" }, { value: "delta", label: "Biggest PT shift", icon: "ArrowUpDown" }]} />
          </div>
        </div>

        {desktop ? <Card className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 font-medium">Rating firm</th><th className="px-3 py-2.5 font-medium">Action</th>
              <th className="px-3 py-2.5 font-medium">Price target shift</th><th className="px-3 py-2.5 font-medium">Headline / rationale</th><th className="px-3 py-2.5 font-medium">Insiders 90d</th><th className="px-4 py-2.5 font-medium">Source article</th>
            </tr></thead>
            <tbody>
              {page.map((a, i) => {
                const s = byTicker[a.ticker];
                return (
                  <tr key={a.date + a.ticker + a.firm + i} className="border-b border-slate-700/40 align-top last:border-0 hover:bg-slate-700/25">
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => onOpen(a.ticker)} className="flex items-center gap-2 font-semibold text-white hover:text-indigo-300">{a.ticker}{s && <ScoreBadge score={s.composite} size="sm" />}</button>
                      <div className="mt-0.5 text-xs text-slate-500">{fmtDate(a.date)}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5 whitespace-nowrap text-slate-200"><Icon name="Building2" size={13} className="text-slate-500" />{a.firm}</div>
                      <div className="mt-0.5 whitespace-nowrap text-xs text-slate-500">{a.fromRating === a.toRating ? a.toRating : a.fromRating + " → " + a.toRating}</div>
                    </td>
                    <td className="px-3 py-3"><ActionPill action={a.action} /></td>
                    <td className="px-3 py-3"><TargetShift a={a} /></td>
                    <td className="min-w-[18rem] px-3 py-3 text-slate-300">{a.headline && <div className="font-medium text-slate-100">{a.headline}</div>}{a.rationale !== a.headline && <div className={a.headline ? "mt-0.5 text-xs text-slate-400" : ""}>{a.rationale}</div>}</td>
                    <td className="px-3 py-3">{s && <InsiderChip insider={s.insider} short />}</td>
                    <td className="px-4 py-3"><SourceBadge href={articleUrl(a)} label={a.source} title={"Open " + a.ticker + " coverage on " + a.source + (a.via ? " · data via " + a.via : "")} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="p-8 text-center text-sm text-slate-400">No analyst actions match these filters.</div>}
        </Card> : (
        <div className="space-y-3">
          {page.map((a, i) => {
            const s = byTicker[a.ticker];
            return (
              <Card key={a.date + a.ticker + a.firm + i} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" onClick={() => onOpen(a.ticker)} className="flex items-center gap-2"><span className="text-base font-bold text-white">{a.ticker}</span>{s && <ScoreBadge score={s.composite} size="sm" />}</button>
                  <ActionPill action={a.action} />
                </div>
                <div className="mt-1 text-xs text-slate-400">{a.firm} · {fmtDate(a.date)} · {a.fromRating === a.toRating ? a.toRating : a.fromRating + " → " + a.toRating}</div>
                <div className="mt-2 text-sm"><TargetShift a={a} /></div>
                {a.headline && <p className="mt-2 text-sm font-medium text-slate-100">{a.headline}</p>}
                {a.rationale !== a.headline && <p className={"text-sm text-slate-300 " + (a.headline ? "mt-1 text-xs text-slate-400" : "mt-2")}>{a.rationale}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">{s && <InsiderChip insider={s.insider} />}<SourceBadge href={articleUrl(a)} label={a.source} title={"Open " + a.ticker + " coverage on " + a.source + (a.via ? " · data via " + a.via : "")} /></div>
              </Card>
            );
          })}
          {rows.length === 0 && <Card className="p-6 text-center text-sm text-slate-400">No analyst actions match these filters.</Card>}
        </div>)}
        <MoreButton shown={shown} total={rows.length} onMore={() => setShown(shown + 40)} />
      </div>

      <InsiderPanel scored={scored} txRes={txRes} />
      <p className="text-xs text-slate-500">Source badges open each ticker's coverage page on that outlet (or its SEC EDGAR Form 4 list). In sample mode the rating and insider entries are illustrative; with a live endpoint, rows carry their own article and filing URLs.</p>
    </div>
  );
}

/* ================= Tab 3: Portfolio Tracker & Rebalancer ================= */
const inputCls = "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-40";

function HoldingForm({ byTicker, scored, priceBook, onAdd }) {
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [err, setErr] = useState("");
  const t = ticker.trim().toUpperCase();
  const isCash = t === "CASH";
  const known = byTicker[t];
  const scanned = !known && priceBook[t];
  const options = useMemo(() => {
    const m = new Map(scored.map((s) => [s.ticker, s.name]));
    Object.entries(priceBook).forEach(([k, v]) => { if (!m.has(k)) m.set(k, v.name); });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [scored, priceBook]);

  function submit(e) {
    e.preventDefault();
    const sh = parseFloat(shares), c = parseFloat(cost);
    if (!t) return setErr("Enter a ticker symbol.");
    if (!isCash && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return setErr("That doesn't look like a ticker symbol (e.g. AAPL, BRK.B).");
    if (!(sh > 0)) return setErr(isCash ? "Enter a cash amount above 0." : "Shares must be above 0.");
    if (!isCash && !(c > 0)) return setErr("Average cost must be above 0.");
    onAdd({ ticker: t, shares: sh, cost: isCash ? 1 : c });
    setTicker(""); setShares(""); setCost(""); setErr("");
  }
  return (
    <Card className="p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="Plus" size={15} className="text-emerald-400" />Add position</h3>
      <form onSubmit={submit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <label className="block"><span className="mb-1 block text-xs text-slate-400">Ticker symbol</span>
          <input list="ticker-list" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="e.g. ABBV or CASH" className={inputCls + " uppercase"} autoComplete="off" />
          <datalist id="ticker-list">{options.map(([k, name]) => <option key={k} value={k}>{name}</option>)}<option value="CASH">Cash balance</option></datalist>
        </label>
        <label className="block"><span className="mb-1 block text-xs text-slate-400">{isCash ? "Cash amount ($)" : "Shares owned"}</span>
          <input type="number" min="0" step="any" value={shares} onChange={(e) => setShares(e.target.value)} placeholder={isCash ? "5000" : "25"} className={inputCls} />
        </label>
        <label className="block"><span className="mb-1 block text-xs text-slate-400">Avg cost basis ($/sh)</span>
          <input type="number" min="0" step="any" value={isCash ? "" : cost} disabled={isCash} onChange={(e) => setCost(e.target.value)} placeholder={isCash ? "n/a" : known ? String(known.price) : scanned ? String(scanned.price) : "150.00"} className={inputCls} />
        </label>
        <button type="submit" className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400"><Icon name="Plus" size={15} />Add</button>
      </form>
      {known && !err && <p className="mt-2 text-xs text-slate-400">{known.name} · {known.sector} · last {px(known.price)} · score {known.composite} · {(HORIZON_INFO[known.horizon] || HORIZON_INFO.core).label} · {known.risk} risk</p>}
      {scanned && !err && <p className="mt-2 text-xs text-slate-400">{scanned.name} · {scanned.sector} · last {px(scanned.price)} · in the market scan (price only, no full score today)</p>}
      {!known && !scanned && !isCash && t && !err && <p className="mt-2 text-xs text-amber-300">{t} isn't in today's data, so it's tracked at your cost basis until a price is available. Add it to the repo's WATCHLIST variable to get it fully checked every day.</p>}
      {err && <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-400"><Icon name="AlertTriangle" size={13} />{err}</p>}
      <p className="mt-2 text-xs text-slate-500">Adding a ticker you already hold merges it at a blended cost basis.</p>
    </Card>
  );
}

function AllocationChart({ sectors, total }) {
  const [hover, setHover] = useState(null);
  const visible = sectors.filter((s) => s.weight > 0);
  const listed = sectors.filter((s) => (s.sector !== "Other" && s.sector !== "Index Funds") || s.weight > 0);
  const h = hover && sectors.find((x) => x.sector === hover);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="PieChart" size={15} className="text-indigo-300" />Sector allocation</h3>
        <span className="text-xs text-slate-400">Limit {pct(L.CONCENTRATION_LIMIT, 0)} per sector</span>
      </div>
      <div className="relative mt-4">
        <div className="flex h-4 w-full gap-[2px]" role="img" aria-label={visible.map((s) => s.sector + " " + pct(s.weight)).join(", ")}>
          {visible.map((s, i) => (
            <div key={s.sector} onMouseEnter={() => setHover(s.sector)} onMouseLeave={() => setHover(null)}
              className={"h-full transition-opacity " + (i === 0 ? "rounded-l " : "") + (i === visible.length - 1 ? "rounded-r" : "")}
              style={{ width: s.weight * 100 + "%", background: s.color, opacity: hover && hover !== s.sector ? 0.45 : 1 }} />
          ))}
        </div>
        <div className="pointer-events-none absolute -top-1 bottom-[-4px] border-l border-dashed border-slate-300/70" style={{ left: L.CONCENTRATION_LIMIT * 100 + "%" }} />
        {h && <div className="pointer-events-none absolute -top-11 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 shadow-lg ring-1 ring-slate-700"><span className="font-semibold">{h.sector}</span> · {pct(h.weight)} · {usd(h.value)}</div>}
      </div>
      <div className="mt-4 space-y-2.5">
        {listed.map((s) => {
          const over = !UNMANAGED_SECTORS.includes(s.sector) && s.weight > L.CONCENTRATION_LIMIT;
          const under = !UNMANAGED_SECTORS.includes(s.sector) && s.weight < L.UNDERWEIGHT_FLOOR;
          return (
            <div key={s.sector} className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-3 text-sm" onMouseEnter={() => setHover(s.sector)} onMouseLeave={() => setHover(null)}>
              <span className="flex min-w-0 items-center gap-2 text-slate-200"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} /><span className="truncate">{s.sector}</span></span>
              <div className="relative h-2 rounded-full bg-slate-700/70">
                <div className="h-2 rounded-full" style={{ width: Math.min(100, s.weight * 100) + "%", background: s.color }} />
                <div className="absolute -top-1 h-4 border-l border-dashed border-slate-400/60" style={{ left: L.CONCENTRATION_LIMIT * 100 + "%" }} />
              </div>
              <span className="flex w-28 items-center justify-end gap-1.5 tabular-nums">
                {over && <span className="rounded bg-rose-500/20 px-1 text-[10px] font-semibold uppercase text-rose-300">Over</span>}
                {under && <span className="rounded bg-slate-700 px-1 text-[10px] font-semibold uppercase text-slate-400">Under</span>}
                <span className="w-12 text-right text-slate-100">{pct(s.weight)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">Dashed line = {pct(L.CONCENTRATION_LIMIT, 0)} concentration limit · Under = below {pct(L.UNDERWEIGHT_FLOOR, 0)} · Total {usd(total)}</p>
    </Card>
  );
}

const ADVICE_STYLE = {
  Sell: ["border-rose-500/40 bg-rose-500/15 text-rose-300", "bg-rose-500 text-white", "XCircle"],
  Trim: ["border-amber-500/40 bg-amber-500/10 text-amber-300", "bg-amber-500 text-slate-900", "Scissors"],
  Review: ["border-amber-500/30 bg-amber-500/5 text-amber-200", "bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40", "Newspaper"],
  "Buy more": ["border-emerald-500/30 bg-emerald-500/10 text-emerald-300", "bg-emerald-500 text-slate-900", "Plus"],
  "Pause adding": ["border-slate-600 bg-slate-900/40 text-slate-300", "bg-slate-700 text-slate-200", "Pause"],
  Hold: ["border-slate-700 bg-slate-900/40 text-slate-300", "bg-slate-700/70 text-slate-300", "CircleCheck"],
};
function ActionChip({ action }) {
  const st = ADVICE_STYLE[action] || ADVICE_STYLE.Hold;
  return <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold " + st[1]}><Icon name={st[2]} size={12} />{action}</span>;
}

function AdviceFeed({ a, onOpen }) {
  const adv = a.feed.filter((f) => f.type === "advice");
  const other = a.feed.filter((f) => f.type !== "advice");
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="ClipboardList" size={15} className="text-indigo-300" />What to do now</h3>
        <span className="text-xs text-slate-400">{Object.entries(a.counts).map(([k, v]) => v + " " + k.toLowerCase()).join(" · ")}</span>
      </div>
      <CheckupBanner rows={a.rows} />
      {a.feed.length === 0 && <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300"><Icon name="CircleCheck" size={16} />Nothing to do: every holding is a hold and the mix is balanced.</div>}
      <div className="mt-3 space-y-2.5">
        {adv.map((f) => {
          const st = ADVICE_STYLE[f.action] || ADVICE_STYLE.Hold;
          return (
            <div key={f.ticker} className={"rounded-lg border p-3 " + st[0]}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => onOpen(f.ticker)} className="flex items-center gap-2 text-sm font-semibold text-white hover:text-indigo-200"><ActionChip action={f.action} />{f.ticker}<span className="font-normal text-slate-400">{pct(f.weight)} of portfolio</span></button>
                {f.score != null && <ScoreBadge score={f.score} size="sm" />}
              </div>
              <ul className="mt-1.5 space-y-0.5">{f.why.map((w) => <li key={w} className="text-sm text-slate-300">• {w}</li>)}</ul>
            </div>
          );
        })}
        {other.map((f, i) => {
          if (f.type === "concentration")
            return (
              <div key={"c" + i} className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-rose-300"><Icon name="AlertTriangle" size={15} />Too much in {f.sector}: {pct(f.weight)}</div>
                <p className="mt-1 text-sm text-slate-300">Trim about <span className="font-semibold text-white">{usd(f.excess)}</span> to get {f.sector} back to {pct(L.CONCENTRATION_LIMIT, 0)}.{f.trimFirst.length > 0 && <> Weakest to trim first: <span className="font-medium text-white">{f.trimFirst.join(", ")}</span>.</>}</p>
              </div>
            );
          if (f.type === "risk")
            return (
              <div key={"r" + i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-300"><Icon name="Gauge" size={15} />{pct(f.share)} of your money is in high-risk names</div>
                <p className="mt-1 text-sm text-slate-300">Some risk is fine when you're young, but over ~40% means a rough month can hurt a lot. High risk: <span className="font-medium text-white">{f.names.join(", ")}</span>. Balance it with a core holding or an index fund.</p>
              </div>
            );
          return (
            <div key={"a" + i} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><Icon name="Lightbulb" size={15} />Idea: {f.stock.ticker}{f.light ? " (you're light in " + f.sector + ")" : ""}</div>
                <button type="button" onClick={() => onOpen(f.stock.ticker)} className="flex items-center gap-2 rounded-md bg-slate-900/60 px-2 py-1 text-sm font-semibold text-white ring-1 ring-slate-700 hover:ring-indigo-500">{f.stock.ticker}<ScoreBadge score={f.stock.composite} size="sm" /></button>
              </div>
              <p className="mt-1 text-sm text-slate-300">{f.stock.name}: {(HORIZON_INFO[f.stock.horizon] || HORIZON_INFO.core).label.toLowerCase()} pick, {f.stock.risk.toLowerCase()} risk. {f.stock.buyPlan ? "Buy the position at once; rethink below " + px(f.stock.buyPlan.stop) + "." : ""}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function HoldingRow({ r, onOpen, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [sh, setSh] = useState(String(r.shares));
  const [c, setC] = useState(String(r.cost));
  const cash = r.ticker === "CASH";
  const begin = () => { setSh(String(r.shares)); setC(String(+r.cost.toFixed(2))); setEditing(true); };
  const save = () => {
    const s = parseFloat(sh), cc = parseFloat(c);
    if (!(s > 0) || (!cash && !(cc > 0))) return;
    onSave(r.id, { shares: s, cost: cash ? 1 : cc });
    setEditing(false);
  };
  const flagged = r.advice && (r.advice.action === "Sell" || r.advice.action === "Trim");
  const cell = "px-3 py-3 text-right tabular-nums";
  return (
    <tr className={"border-b border-slate-700/40 last:border-0 " + (flagged ? "bg-rose-500/5" : "")}>
      <td className="px-4 py-3">
        {cash ? <div className="font-semibold text-white">Cash</div> : <button type="button" onClick={() => onOpen(r.ticker)} className="font-semibold text-white hover:text-indigo-300">{r.ticker}</button>}
        <div><SectorChip sector={r.sector} /></div>
      </td>
      <td className={cell + " text-slate-300"}>
        {editing ? <input type="number" step="any" min="0" value={sh} onChange={(e) => setSh(e.target.value)} aria-label={cash ? "Cash amount" : "Shares"} className="w-24 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-right text-sm text-slate-100 focus:border-indigo-500 focus:outline-none" />
          : cash ? usd(r.shares) : r.shares.toLocaleString("en-US")}
      </td>
      <td className={cell + " text-slate-300"}>
        {cash ? "—" : editing ? <input type="number" step="any" min="0" value={c} onChange={(e) => setC(e.target.value)} aria-label="Average cost" className="w-24 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-right text-sm text-slate-100 focus:border-indigo-500 focus:outline-none" /> : usd(r.cost, 2)}
      </td>
      <td className={cell + " text-slate-300"}>{cash ? "—" : px(r.price)}</td>
      <td className={cell + " font-medium text-slate-100"}>{usd(r.value)}</td>
      <td className={cell + " " + tone(r.pl)}>{cash ? "—" : <>{usd(r.pl)} <span className="text-xs opacity-80">({spct(r.plPct)})</span></>}</td>
      <td className="max-w-[16rem] px-3 py-3">{r.advice ? <div title={r.advice.why.join("\n")}><ActionChip action={r.advice.action} /><div className="mt-0.5 truncate text-[11px] text-slate-400">{r.advice.why[0]}</div>{r.stock && r.stock.upd && r.stock.upd.events.length > 0 && (Date.now() - Date.parse(r.stock.upd.date)) / 864e5 <= 5 && <div className={"mt-0.5 truncate text-[11px] " + (r.stock.upd.tone === "bad" ? "text-rose-300" : r.stock.upd.tone === "good" ? "text-emerald-300" : "text-slate-300")}>Today: {r.stock.upd.events.map((e) => e.text).join(" · ")}</div>}</div> : r.unpriced ? <span className="text-xs text-amber-300">No price data yet (held at cost)</span> : <span className="text-slate-500">—</span>}</td>
      <td className={cell + " text-slate-300"}>{pct(r.weight)}</td>
      <td className="px-3 py-3">{r.score != null ? <ScoreBadge score={r.score} size="sm" /> : <span className="text-slate-500">—</span>}</td>
      <td className="relative whitespace-nowrap px-3 py-3 text-right">
        {editing ? (
          <>
            <button type="button" onClick={save} aria-label={"Save " + r.ticker} className="rounded p-1 text-emerald-400 hover:bg-emerald-500/15"><Icon name="Check" size={15} /></button>
            <button type="button" onClick={() => setEditing(false)} aria-label="Cancel edit" className="rounded p-1 text-slate-400 hover:bg-slate-700"><Icon name="X" size={15} /></button>
          </>
        ) : (
          <>
            <button type="button" onClick={begin} aria-label={"Edit " + r.ticker} className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white"><Icon name="Pencil" size={15} /></button>
            <button type="button" onClick={() => onDelete(r.id)} aria-label={"Delete " + r.ticker} className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-400"><Icon name="Trash2" size={15} /></button>
          </>
        )}
      </td>
    </tr>
  );
}

/* Phone ↔ Mac sync card */
function SyncCard({ sync }) {
  const [codeIn, setCodeIn] = useState("");
  const [copied, setCopied] = useState(null);
  const [show, setShow] = useState(false);
  if (!sync.available) return null;
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 2000); } catch (e) { setShow(true); }
  };
  const when = sync.at ? sync.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const badge = { off: ["Off", "bg-slate-700 text-slate-300"], syncing: ["Syncing…", "bg-indigo-500/20 text-indigo-200"],
    synced: ["Synced" + (when ? " · " + when : ""), "bg-emerald-500/15 text-emerald-300"], error: ["Not synced", "bg-rose-500/15 text-rose-300"] }[sync.status] || ["", ""];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="MonitorSmartphone" size={15} className="text-indigo-300" />Sync across devices</h3>
        <span className={"rounded-full px-2.5 py-0.5 text-xs font-medium " + badge[1]}>{badge[0]}</span>
      </div>
      {sync.note && <p className="mt-2 text-xs text-slate-300">{sync.note}</p>}
      {sync.error && <p className="mt-2 text-xs text-rose-300">{sync.error}</p>}
      {!sync.code ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-400">Keep the same portfolio on your phone and computer. Turn it on here, then open the link it gives you on your other device.</p>
          <button type="button" onClick={sync.start} className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400">Turn on sync</button>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (sync.join(codeIn)) setCodeIn(""); }}>
            <input value={codeIn} onChange={(e) => setCodeIn(e.target.value)} placeholder="Already on? Paste your sync code" autoComplete="off" spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none" />
            <button type="submit" className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700">Connect</button>
          </form>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-400">On your other device, open this link (or paste the code there). Changes then show up on both. Keep it private: anyone with it can see and edit your portfolio.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => copy(sync.link, "link")} className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400"><Icon name={copied === "link" ? "Check" : "Link"} size={14} />{copied === "link" ? "Link copied" : "Copy sync link"}</button>
            <button type="button" onClick={() => setShow((v) => !v)} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700">{show ? "Hide code" : "Show code"}</button>
            <button type="button" onClick={sync.refresh} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700">Sync now</button>
            <button type="button" onClick={sync.stop} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white">Turn off on this device</button>
          </div>
          {show && <p className="break-all rounded-lg bg-slate-900 px-3 py-2 font-mono text-sm tracking-wider text-slate-100">{sync.code}</p>}
        </div>
      )}
    </Card>
  );
}

/** "I have $X to invest": what to buy now, sized to the portfolio. */
function NewMoneyPlanner({ a, scored, onOpen }) {
  const [raw, setRaw] = useState("");
  const cash = Number(String(raw).replace(/[^0-9.]/g, "")) || 0;
  const plan = useMemo(() => planNewMoney(cash, a, scored), [cash, a, scored]);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="Wallet" size={15} className="text-emerald-300" />Have money to invest?</h3>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <span>Amount</span>
          <span className="relative"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500">$</span>
            <input inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="200" aria-label="Amount to invest"
              className="w-28 rounded-lg border border-slate-600 bg-slate-900 py-1.5 pl-6 pr-2 text-sm text-white placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none" /></span>
        </label>
      </div>
      {cash <= 0 ? (
        <p className="mt-2 text-sm text-slate-400">Type an amount and I'll split it: about half tops up your index funds (until they're ~50% of your money), the rest buys the best picks, sized by risk.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {plan.items.map((x) => (
            <div key={x.ticker + x.kind} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg bg-slate-900/50 px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold tabular-nums text-emerald-300">{usd(x.amount)}</span>
                <button type="button" onClick={() => x.stock && onOpen(x.ticker)} className="text-sm font-semibold text-white hover:text-indigo-200">{x.ticker}</button>
                <span className="text-xs text-slate-400">{x.kind === "core" ? "index-fund core" : x.kind === "add" ? "add to your position" : "new position"}</span>
              </div>
              <div className="text-xs text-slate-400">{x.kind === "core" ? x.why : "Target " + usd(x.target) + " (" + Math.round(x.pct * 100) + "%) · score " + x.stock.composite + " · " + x.stock.risk.toLowerCase() + " risk" + (x.amount < x.target - 1 ? " · rest from future money" : "")}</div>
            </div>
          ))}
          <p className="text-xs text-slate-500">Buy each one all at once (tested better than waiting for dips). Fractional shares are fine.</p>
        </div>
      )}
    </Card>
  );
}

function PortfolioTab({ scored, byTicker, priceBook, pf, a, onOpen }) {
  const { addHolding, updateHolding, deleteHolding, resetPortfolio, sync } = pf;
  const rows = a.rows.slice().sort((x, y) => ((x.advice ? x.advice.rank : 9) - (y.advice ? y.advice.rank : 9)) || y.value - x.value);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total portfolio value" value={usd(a.total)} sub={rows.length + " positions incl. cash"} icon="Briefcase" />
        <Stat label="Overall P/L" value={usd(a.pl)} sub={"on " + usd(a.costTotal) + " cost basis"} valueTone={a.pl >= 0 ? "up" : "down"} icon={a.pl >= 0 ? "TrendingUp" : "TrendingDown"} />
        <Stat label="To act on" value={(a.counts.Sell || 0) + (a.counts.Trim || 0) + (a.counts["Buy more"] || 0) + (a.counts.Review || 0)}
          sub={[["Sell", a.counts.Sell], ["Trim", a.counts.Trim], ["Buy more", a.counts["Buy more"]], ["Review", a.counts.Review]].filter(([, v]) => v).map(([k, v]) => v + " " + k.toLowerCase()).join(" · ") || "all holds"} icon="ClipboardList" />
        <Stat label="Overall P/L %" value={spct(a.plPct)} sub="unrealized, excludes cash" valueTone={a.plPct >= 0 ? "up" : "down"} icon="Percent" />
      </div>
      <HoldingForm byTicker={byTicker} scored={scored} priceBook={priceBook} onAdd={addHolding} />
      <SyncCard sync={sync} />
      <NewMoneyPlanner a={a} scored={scored} onOpen={onOpen} />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <AllocationChart sectors={a.sectors} total={a.total} />
        <AdviceFeed a={a} onOpen={onOpen} />
      </div>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="Layers" size={15} className="text-indigo-300" />Holdings</h3>
          <button type="button" onClick={resetPortfolio} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"><Icon name="RotateCcw" size={12} />Reset to sample</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1020px] text-sm">
            <thead><tr className="border-y border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 text-right font-medium">Shares</th><th className="px-3 py-2.5 text-right font-medium">Avg cost</th>
              <th className="px-3 py-2.5 text-right font-medium">Price</th><th className="px-3 py-2.5 text-right font-medium">Value</th><th className="px-3 py-2.5 text-right font-medium">P/L</th>
              <th className="px-3 py-2.5 font-medium">Action</th><th className="px-3 py-2.5 text-right font-medium">Weight</th><th className="px-3 py-2.5 font-medium">Score</th>
              <th className="relative px-3 py-2.5"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => <HoldingRow key={r.id} r={r} onOpen={onOpen} onSave={updateHolding} onDelete={deleteHolding} />)}
              {rows.length === 0 && <tr><td colSpan={10} className="p-8 text-center text-slate-400">No positions yet. Add one above.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ============================ Detail modal ============================ */
function StockModal({ s, onClose }) {
  const ref = useRef(null);
  useScrollLock(!!s);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => { if (ref.current) { ref.current.scrollTop = 0; ref.current.focus({ preventScroll: true }); } }, [s && s.ticker]);
  if (!s) return null;
  const verdict = s.composite >= L.HIGH_CONVICTION ? ["Top Pick", "text-emerald-300 bg-emerald-500/15"]
    : s.composite >= L.RECOMMEND ? ["Recommended Buy", "text-emerald-300 bg-emerald-500/10"]
    : s.composite >= L.REVIEW_SCORE ? ["Watchlist", "text-slate-300 bg-slate-700"] : ["Avoid / Review", "text-rose-300 bg-rose-500/15"];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={s.ticker + " score breakdown"} onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] supports-[height:100dvh]:max-h-[92dvh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-2xl border border-slate-700 bg-slate-800 p-5 shadow-2xl focus:outline-none sm:rounded-2xl">
        <div style={{ top: "-1.25rem", marginTop: "-1.25rem" }} className="sticky z-10 -mx-5 flex items-start justify-between gap-3 border-b border-slate-700/60 bg-slate-800 px-5 pb-3 pt-5">
          <div className="flex items-center gap-3">
            <ScoreBadge score={s.composite} size="lg" />
            <div>
              <div className="flex items-baseline gap-2"><span className="text-xl font-bold text-white">{s.ticker}</span><span className="tabular-nums text-slate-300">{px(s.price)}</span></div>
              <div className="text-sm text-slate-400">{s.name} · {s.sector}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white"><Icon name="X" size={18} /></button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={"rounded-md px-2 py-0.5 text-xs font-semibold " + verdict[1]}>{verdict[0]}</span>
          <InsiderChip insider={s.insider} />
          <span className="text-xs text-slate-400">β {s.beta.toFixed(2)} · {s.analystCount ?? "n/a"} analysts · {s.buyPct != null ? Math.round(s.buyPct * 100) + "% Buy" : "no consensus"}{s.live ? " · live data" : ""}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5"><HorizonChip s={s} /><RiskChip risk={s.risk} /><FvgPill fvg={s.fvg} />{s.carried && s.checkedAt && <span className="rounded-md bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400">Full check {fmtDate(s.checkedAt)}</span>}</div>
        <div className="mt-3"><UpdateBox s={s} /></div>
        <div className="mt-3"><AiTake s={s} full /></div>
        <div className="mt-3"><BuyPlanBox s={s} /></div>
        {(s.newsFlags || []).length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">Headlines to check</div>
            <ul className="mt-1 space-y-0.5">{s.newsFlags.map((n) => <li key={n.headline} className="text-xs text-slate-300">• {n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline">{n.headline}</a> : n.headline} <span className="text-slate-500">({fmtDate(n.date)})</span></li>)}</ul>
          </div>
        )}
        <div className="mt-5 space-y-4">
          {FACTORS.map((p) => (
            <div key={p.k}>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold text-slate-100"><Icon name={p.icon} size={14} className="text-indigo-300" />{p.label}</span>
                <span className="tabular-nums text-slate-300">{s[p.k]} <span className="text-slate-500">/ {p.max}</span></span>
              </div>
              <div className="mt-2 space-y-1.5">
                {s.breakdown[p.k].map((b) => (
                  <div key={b.label} className="grid grid-cols-[1fr_auto] gap-x-3 rounded-lg bg-slate-900/50 px-3 py-2 sm:grid-cols-[11rem_1fr_auto]">
                    <span className="text-sm text-slate-200">{b.label}</span>
                    <span className="order-3 col-span-2 text-xs text-slate-500 sm:order-none sm:col-span-1 sm:text-sm sm:text-slate-300">{b.value} <span className="hidden text-xs text-slate-500 sm:inline">· {b.rule}</span></span>
                    <span className={"text-right text-sm font-medium tabular-nums " + (b.pts >= b.max ? "text-emerald-400" : b.pts === 0 ? "text-rose-400" : "text-slate-200")}>{b.pts}/{b.max}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================ Settings drawer ============================ */
const SOURCE_LABEL = { supabase: "Supabase", "static-json": "Nightly JSON", live: "Live APIs", mock: "Sample data" };

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

function SettingsDrawer({ settings, onSave, onClose, status }) {
  useScrollLock(true);
  const [draft, setDraft] = useState(settings);
  const [show, setShow] = useState(false);
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    ref.current && ref.current.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const keyInput = (k, ph) => (
    <input type={show ? "text" : "password"} value={draft[k]} onChange={set(k)} placeholder={ph} autoComplete="off" spellCheck={false} className={inputCls + " font-mono text-xs"} />
  );
  const rows = [
    ["Screener", status.screener],
    ["Analyst feed", status.feed],
    ["Insider trades", status.insider],
  ];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60 backdrop-blur-sm" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Data settings" onClick={(e) => e.stopPropagation()}
        className="flex h-full supports-[height:100dvh]:max-h-[100dvh] w-full max-w-md flex-col overflow-y-auto overscroll-contain border-l border-slate-700 bg-slate-800 p-5 shadow-2xl focus:outline-none">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Icon name="Settings" size={17} className="text-indigo-300" />Data settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white"><Icon name="X" size={18} /></button>
        </div>

        <div className="mt-4 rounded-lg bg-slate-900/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current sources</div>
          <div className="mt-2 space-y-1.5">
            {rows.map(([k, r]) => (
              <div key={k} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-slate-300">{k}</span>
                <span className="text-right">
                  <span className={r.source === "mock" ? "text-amber-300" : "text-emerald-300"}>{SOURCE_LABEL[r.source] || r.source}</span>
                  {r.notes && r.notes.length > 0 && <span className="block text-[11px] text-slate-500">{r.notes[0]}</span>}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Order tried: Supabase → nightly JSON from the GitHub Action → live APIs with your keys → sample data.</p>
        </div>

        <div className="mt-4 space-y-4">
          <Field label="Mode">
            <Segmented label="Data mode" value={draft.mode} onChange={(v) => setDraft({ ...draft, mode: v })}
              options={[{ value: "auto", label: "Auto (live when available)", icon: "Radio" }, { value: "mock", label: "Sample data only", icon: "FlaskConical" }]} />
          </Field>

          <div className="space-y-3 rounded-lg border border-slate-700 p-3">
            <div className="text-sm font-semibold text-white">Supabase (pre-computed by the GitHub Action)</div>
            <Field label="Project URL"><input value={draft.supabaseUrl} onChange={set("supabaseUrl")} placeholder="https://YOUR-PROJECT.supabase.co" className={inputCls} /></Field>
            <Field label="Anon (public) key" hint="Read-only with the RLS policies in supabase/schema.sql. Never paste the service_role key here.">{keyInput("supabaseAnonKey", "eyJhbGciOi…")}</Field>
          </div>

          <div className="space-y-3 rounded-lg border border-slate-700 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">Live API keys (browser)</span>
              <button type="button" onClick={() => setShow(!show)} className="text-xs text-slate-400 hover:text-white">{show ? "Hide" : "Show"} keys</button>
            </div>
            <Field label="Financial Modeling Prep" hint="Quotes, DCF, price targets, analyst grades, daily candles (FVG detection).">{keyInput("fmpKey", "FMP API key")}</Field>
            <Field label="Finnhub" hint="Real-time quotes, recommendation trends, insider trades (insider may need a paid plan).">{keyInput("finnhubKey", "Finnhub API key")}</Field>
            <Field label="Alpha Vantage" hint="PEG, forward P/E, analyst ratings; backup candles. 25 calls/day on free.">{keyInput("alphaVantageKey", "Alpha Vantage API key")}</Field>
            <Field label="Watchlist" hint="Comma-separated tickers. Empty = the default 25-stock universe. Fewer tickers = fewer API calls.">
              <input value={draft.watchlist} onChange={set("watchlist")} placeholder="NVDA, APP, LLY, SCHW" className={inputCls + " uppercase"} />
            </Field>
            <p className="text-[11px] text-slate-500">Keys are saved only in this browser. Results are cached ({draft.quoteTtlMin} min for quotes, {draft.fundamentalsTtlHours} h for everything else) to stay inside free limits.</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => onSave(draft)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400"><Icon name="Save" size={15} />Save &amp; reload data</button>
          <button type="button" onClick={() => { clearLiveCache(); onSave(draft); }} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-600"><Icon name="RefreshCw" size={14} />Clear cache &amp; refetch</button>
          <button type="button" onClick={() => setDraft({ ...DEFAULT_SETTINGS })} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white">Reset</button>
        </div>
      </div>
    </div>
  );
}

/* ================================ Shell ================================ */
const TABS = [
  { id: "picks", label: "Long-term Picks", short: "Long-term", icon: "Target" },
  { id: "short", label: "Short-term Trades", short: "Short-term", icon: "Zap" },
  { id: "intelligence", label: "Analyst & Insider Intelligence", short: "Intel", icon: "Newspaper" },
  { id: "portfolio", label: "Portfolio & Advisor", short: "Portfolio", icon: "Briefcase" },
];
const tabFromHash = () => {
  const h = (typeof location !== "undefined" ? location.hash : "").replace("#", "").split("&")[0];
  return TABS.some((t) => t.id === h) ? h : "picks";
};

export default function App() {
  const [tab, setTab] = useState(tabFromHash);
  const [open, setOpen] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useSettings();
  const screener = useScreenerData(settings);
  const feedRaw = useAnalystFeed(settings);
  const insiderRaw = useInsiderActivity(settings);
  const scanRes = useScan(settings);
  const shortRes = useShort(settings);
  // Never blend sample analyst/insider rows into real stock data: if the screener is live but a feed fell back to samples, show it empty.
  const liveScreener = screener.source !== "mock";
  const blank = (r, msg) => ({ ...r, data: { ...r.data, items: [] }, notes: [msg, ...(r.notes || [])] });
  const feed = useMemo(() => (liveScreener && feedRaw.source === "mock" ? blank(feedRaw, "No live analyst data yet: add a Finnhub or FMP key") : feedRaw), [liveScreener, feedRaw]);
  const insider = useMemo(() => (liveScreener && insiderRaw.source === "mock" ? blank(insiderRaw, "No live insider data (Finnhub insider endpoint may need a paid plan)") : insiderRaw), [liveScreener, insiderRaw]);

  const scored = useMemo(() => scoreUniverse(screener.data.stocks, screener.data.sectorPE, insider.data.items), [screener.data, insider.data]);
  const byTicker = useMemo(() => Object.fromEntries(scored.map((s) => [s.ticker, s])), [scored]);
  const pf = usePortfolio();
  const scanLive = screener.source !== "mock" ? scanRes.data : null;
  const priceBook = useMemo(() => Object.fromEntries(((scanLive && scanLive.items) || []).map((r) => [r.ticker, r])), [scanLive]);
  const analysis = useMemo(() => analyzePortfolio(pf.holdings, byTicker, SECTORS, SECTOR_COLORS, priceBook, { analyst: feed.data.items }), [pf.holdings, byTicker, priceBook, feed.data]);
  const holdingRows = useMemo(() => Object.fromEntries(analysis.rows.filter((r) => r.stock).map((r) => [r.ticker, r])), [analysis]);

  useEffect(() => {
    const f = () => setTab(tabFromHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const go = (id) => { setTab(id); try { history.replaceState(null, "", "#" + id); } catch (e) { location.hash = id; } };
  const close = useCallback(() => setOpen(null), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const src = screener.source;
  const live = src !== "mock";
  const chip = screener.progress
    ? "Loading live data " + screener.progress.done + "/" + screener.progress.total + "…"
    : SOURCE_LABEL[src] + (live && screener.data.asOf ? " · " + fmtDate(screener.data.asOf) : "");

  return (
    <PortfolioValue.Provider value={analysis.total}>
    <HoldingRows.Provider value={holdingRows}>
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500"><Icon name="Landmark" size={18} className="text-white" /></div>
              <div className="min-w-0">
                <h1 className="text-base font-bold leading-tight text-white sm:text-lg">Wealth &amp; Stock Intelligence Engine</h1>
                <div className="text-[11px] leading-tight text-slate-400">Momentum · Earnings trend · Quality · Value · Smart money · as of {fmtDate(screener.data.asOf || new Date().toISOString().slice(0, 10))}</div>
              </div>
            </div>
            <div className="order-last w-full sm:order-none sm:w-auto">
              <StockSearch scanItems={scanLive && scanLive.items} rankedCount={scanLive && scanLive.rankedCount} byTicker={byTicker}
                shortItems={shortRes.data && shortRes.data.items} holdingRows={holdingRows} onOpen={setOpen} onGoShort={() => go("short")} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>
                Autonomous Market Screener: Active
              </span>
              <button type="button" onClick={() => setDrawer(true)} title="Data sources and API keys"
                className={"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition hover:brightness-125 " + (live ? "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30" : "bg-amber-500/15 text-amber-300 ring-amber-500/30")}>
                <Icon name={screener.loading ? "Loader" : "Database"} size={11} className={screener.loading ? "animate-spin" : ""} />{chip}<Icon name="Settings" size={11} />
              </button>
            </div>
          </div>
          <nav className="-mb-px flex gap-1 overflow-x-auto" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}
                className={"flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition " + (tab === t.id ? "border-indigo-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200")}>
                <Icon name={t.icon} size={15} /><span className="hidden sm:inline">{t.label}</span><span className="sm:hidden">{t.short}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      {!live && settings.mode !== "mock" && !screener.loading && (
        <div className="mx-auto mt-4 max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <span className="flex items-center gap-2"><Icon name="Info" size={15} />Showing sample data. Connect Supabase or add free API keys to load live quotes, DCF values and analyst ratings.</span>
            <button type="button" onClick={() => setDrawer(true)} className="rounded-md bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/30">Open settings</button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === "picks" && <Picks scored={scored} byTicker={byTicker} scan={screener.source !== "mock" ? scanRes.data : null} onOpen={setOpen} />}
        {tab === "short" && <ShortTermTab data={shortRes.data} byTicker={byTicker} priceBook={priceBook} pf={pf} total={analysis.total} onOpen={setOpen} />}
        {tab === "intelligence" && <Intelligence scored={scored} byTicker={byTicker} feedRes={feed} txRes={insider} onOpen={setOpen} />}
        {tab === "portfolio" && <PortfolioTab scored={scored} byTicker={byTicker} priceBook={priceBook} pf={pf} a={analysis} onOpen={setOpen} />}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-slate-500 sm:px-6">
        {live ? "Screener data: " + SOURCE_LABEL[src] + ". Scores, buy levels and stops are computed from daily charts, analyst estimates and financial statements by the rules in the methodology panel."
          : "Prices, FVG zones, targets, analyst actions and insider trades are illustrative sample data."} Scores are a screening aid, not investment advice.
      </footer>

      {open && byTicker[open] && <StockModal s={byTicker[open]} onClose={close} />}
      {drawer && <SettingsDrawer settings={settings} status={{ screener, feed, insider }} onClose={closeDrawer}
        onSave={(next) => { setSettings({ ...next }); setDrawer(false); }} />}
    </div>
    </HoldingRows.Provider>
    </PortfolioValue.Provider>
  );
}
