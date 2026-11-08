/**
 * App.jsx — Wealth & Stock Intelligence Engine (UI): swing + position screener.
 */
import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as LucideIcons from "lucide-react";
import { SECTORS, SECTOR_COLORS, SOURCE_URLS, insiderSourceUrl } from "./mockData.js";
import { LIMITS, UNMANAGED_SECTORS, scoreUniverse, analyzePortfolio } from "./scoring.js";
import { useScreenerData, useAnalystFeed, useInsiderActivity, useScan, usePortfolio, useSettings, clearLiveCache } from "./api.js";
import { DEFAULT_SETTINGS } from "./config.js";
import { ruleSummary } from "./lib/ai.js";

const L = LIMITS;

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

const PILLARS = [
  { k: "technical", label: "HTF Technical", icon: "Activity", max: 35 },
  { k: "fundamental", label: "Valuation", icon: "Scale", max: 35 },
  { k: "sentiment", label: "Street + Insiders", icon: "Building2", max: 30 },
];

function PillarBars({ s }) {
  return (
    <div className="space-y-1.5">
      {PILLARS.map((p) => (
        <div key={p.k} className="flex items-center gap-2 text-[11px]">
          <span className="w-24 shrink-0 text-slate-400">{p.label}</span>
          <div className="h-1.5 flex-1 rounded-full bg-slate-700"><div className="h-1.5 rounded-full bg-indigo-400" style={{ width: (s[p.k] / p.max) * 100 + "%" }} /></div>
          <span className="w-12 shrink-0 text-right tabular-nums text-slate-300">{s[p.k]}<span className="text-slate-500">/{p.max}</span></span>
        </div>
      ))}
    </div>
  );
}

/* ===================== Tab 1: Swing & Position Picks ===================== */
const SORTS = [
  { value: "composite", label: "Composite Score", icon: "Award" },
  { value: "upside1m", label: "1-Mo Upside", icon: "Zap" },
  { value: "upside6m", label: "6-Mo Upside", icon: "Target" },
  { value: "technical", label: "Technical Setup", icon: "Activity" },
];
const HORIZONS = [
  { value: "all", label: "All horizons" },
  { value: "swing", label: "Swing (~1 mo)", icon: "Zap" },
  { value: "position", label: "Position (~6 mo)", icon: "CalendarRange" },
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

const PLAN_STATUS = {
  live: ["Entry live", "bg-emerald-500 text-slate-900", "Zap"],
  extended: ["Extended · wait for retest", "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30", "Hourglass"],
  testing: ["Testing FVG · wait for rejection", "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30", "Crosshair"],
  failed: ["Below stop · setup failed", "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30", "XCircle"],
  none: ["No FVG setup", "bg-slate-700/60 text-slate-400 ring-1 ring-slate-600/50", "Minus"],
};
function PlanPill({ s }) {
  const p = PLAN_STATUS[s.plan.status];
  return <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold " + p[1]}><Icon name={p[2]} size={12} />{p[0]}</span>;
}

const pz = (x) => (!ok(x) ? "—" : "$" + (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)));

function PlanCell({ label, value, sub, valueCls = "text-slate-100", subCls = "text-slate-500" }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={"truncate text-sm font-semibold tabular-nums " + valueCls}>{value}</div>
      {sub && <div className={"truncate text-[11px] tabular-nums " + subCls}>{sub}</div>}
    </div>
  );
}

function TradePlan({ s }) {
  const hasPlan = s.plan.status !== "none";
  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-slate-900/60 p-2.5">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400"><Icon name="Zap" size={11} />Swing plan · ~1 month</div>
        {hasPlan ? (
          <div className="grid grid-cols-[1.35fr_1fr_1fr_1fr] gap-2">
            <PlanCell label="Entry (FVG)" value={pz(s.fvg.lo) + "–" + pz(s.fvg.hi).slice(1)} />
            <PlanCell label="Stop" value={pz(s.stop)} sub={"-" + pct(s.plan.riskPct)} valueCls="text-rose-300" />
            <PlanCell label="Target" value={pz(s.target1m)} sub={spct(s.upside1m)} valueCls="text-emerald-300" subCls="text-emerald-400/80" />
            <PlanCell label="Reward:risk" value={s.plan.rr.toFixed(1) + ":1"} valueCls={s.plan.rr >= L.MIN_RR ? "text-emerald-300" : "text-amber-300"} />
          </div>
        ) : (
          <div className="text-xs text-slate-400">No bullish FVG to trade off. 1-mo target {pz(s.target1m)} ({spct(s.upside1m)}).</div>
        )}
      </div>
      <div className="rounded-lg bg-slate-900/60 p-2.5">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-300"><Icon name="CalendarRange" size={11} />Position · ~6 months</div>
        <div className="grid grid-cols-[1.35fr_1fr_1fr_1fr] gap-2">
          <PlanCell label="6-mo target" value={pz(s.target6m)} sub={spct(s.upside6m)} valueCls="text-emerald-300" subCls="text-emerald-400/80" />
          <PlanCell label="DCF value" value={pz(s.dcfValue)} sub={spct(s.dcfUpside, 0)} subCls={tone(s.dcfUpside)} />
          <PlanCell label="Street PT" value={pz(s.target12m)} sub="12-mo" />
          <PlanCell label="Beta" value={s.beta.toFixed(2)} sub="vs SPY" />
        </div>
      </div>
    </div>
  );
}

function BuyZone({ s }) {
  const [lo, hi] = s.buyZone;
  const min = Math.min(lo, s.price) * 0.94, max = Math.max(hi, s.price) * 1.06;
  const x = (v) => ((v - min) / (max - min)) * 100;
  const status = {
    in: ["In zone · accumulate", "text-emerald-300 bg-emerald-500/15 ring-emerald-500/30", "CircleCheck"],
    below: ["Below zone · deep value", "text-emerald-300 bg-emerald-500/20 ring-emerald-500/40", "ArrowDownToLine"],
    above: ["Above zone · wait", "text-amber-300 bg-amber-500/15 ring-amber-500/30", "Hourglass"],
  }[s.zoneStatus];
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">DCA buy zone (longer hold)</span>
        <span className={"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 " + status[1]}><Icon name={status[2]} size={11} />{status[0]}</span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-slate-700/80">
        <div className="absolute h-2 rounded bg-emerald-500/50" style={{ left: x(lo) + "%", width: x(hi) - x(lo) + "%" }} />
        <div className="absolute -top-1 h-4 w-0.5 rounded bg-white" style={{ left: "calc(" + x(s.price) + "% - 1px)" }} title={"Price " + px(s.price)} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-400">
        <span>{px(lo)} – {px(hi)}</span><span>Price {px(s.price)}</span>
      </div>
    </div>
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
  const t = s.ai || ruleSummary(s);
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
        <PlanPill s={s} />
        <FvgPill fvg={s.fvg} />
        {s.fib != null && s.fib >= 0.618 && <span className="rounded-md bg-slate-700/60 px-2 py-0.5 text-xs text-slate-300 ring-1 ring-slate-600/50">Fib {s.fib.toFixed(3)}</span>}
        {s.support && <span className="rounded-md bg-slate-700/60 px-2 py-0.5 text-xs text-slate-300 ring-1 ring-slate-600/50">Support</span>}
        {s.partial && s.partial.length > 0 && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300 ring-1 ring-amber-500/30" title={"Not available on the free data plan, scored as neutral: " + s.partial.join(", ")}>
            Partial data
          </span>
        )}
      </div>

      <div className="mt-3"><AiTake s={s} /></div>
      <div className="mt-3"><TradePlan s={s} /></div>
      <div className="mt-4"><BuyZone s={s} /></div>

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">Catalysts</div>
        <ul className="mt-1.5 space-y-1">
          {s.catalysts.slice(0, 3).map((c) => (
            <li key={c} className="flex gap-2 text-sm text-slate-300"><Icon name="TrendingUp" size={14} className="mt-0.5 shrink-0 text-emerald-400" />{c}</li>
          ))}
        </ul>
      </div>
      <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-400"><Icon name="AlertTriangle" size={12} />Invalidation watch</div>
        <ul className="mt-1 space-y-0.5">
          {s.invalidationAll.map((c) => <li key={c} className="text-xs text-slate-300">• {c}</li>)}
        </ul>
      </div>

      <div className="mt-4 border-t border-slate-700/60 pt-3"><PillarBars s={s} /></div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <InsiderChip insider={s.insider} />
        <button type="button" onClick={() => onOpen(s.ticker)} className="flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200">Score breakdown <Icon name="ArrowRight" size={12} /></button>
      </div>
    </div>
  );
}

function Methodology() {
  const [open, setOpen] = useState(false);
  const rows = [
    ["35%", "HTF Technical Setup", "Bullish FVG: Weekly rejection 20 / Daily rejection 16 / testing 8–10 · Fib 0.618+ confluence 10 (0.5 = 4) · key structural support 5"],
    ["35%", "Fundamental Value", "DCF ≥20% below fair value (15) · PEG < 1.0 (10, fades to 0 at 2.0) · forward P/E ≥20% below sector (10)"],
    ["30%", "Wall Street & Insiders", "Buy consensus ≥75% (10) · 12-month price-target upside ≥25% (12) · insider open-market buying over 90 days (8; routine selling isn't penalized)"],
  ];
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-700/40">
        <span className="flex items-center gap-2"><Icon name="Info" size={15} className="text-indigo-300" />Scoring methodology & trade-plan rules</span>
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
          <div className="rounded-lg bg-slate-900/50 p-3 text-sm text-slate-400">
            <span className="font-medium text-slate-200">Swing plan:</span> entry is the bullish FVG, the stop sits under it, the target is the ~1-month objective. Reward:risk is measured from the middle of the FVG. <span className="text-emerald-300">Entry live</span> = FVG rejected and price no more than {pct(L.ENTRY_TOLERANCE, 0)} above it, with at least {L.MIN_RR}:1 reward:risk.
            <br /><span className="font-medium text-slate-200">Position fit:</span> 6-month target at least 15% above price. The DCA zone is for building a longer hold in pieces.
          </div>
          <p className="text-xs text-slate-500">Linear partial credit between thresholds. A metric the free data plans don't provide counts as neutral (half credit) and the card is tagged "Partial data". Composite ≥ {L.RECOMMEND} = Recommended Buy; ≥ {L.HIGH_CONVICTION} = High Conviction; {L.WATCH}–{L.RECOMMEND - 1} = Watchlist; holdings below {L.REVIEW_SCORE} get a review flag.</p>
          <p className="text-xs text-slate-500">How stocks are found: every weekday the job scans ~550 stocks (S&amp;P 500, Nasdaq-100 and popular momentum names) on daily charts, then gives the best FVG setups and biggest movers the full check.</p>
        </div>
      )}
    </Card>
  );
}

function WatchRow({ s, onOpen }) {
  return (
    <tr onClick={() => onOpen(s.ticker)} className="cursor-pointer border-b border-slate-700/40 last:border-0 hover:bg-slate-700/30">
      <td className="px-4 py-2.5"><div className="font-semibold text-white">{s.ticker}</div><SectorChip sector={s.sector} /></td>
      <td className="px-3 py-2.5"><ScoreBadge score={s.composite} size="sm" /></td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{px(s.price)}</td>
      <td className="px-3 py-2.5"><PlanPill s={s} /></td>
      <td className={"px-3 py-2.5 text-right tabular-nums " + tone(s.upside1m)}>{spct(s.upside1m)}</td>
      <td className={"px-3 py-2.5 text-right tabular-nums " + tone(s.upside6m)}>{spct(s.upside6m)}</td>
      <td className="px-3 py-2.5 text-xs text-slate-400">{s.partial && s.partial.length ? "Partial data" : ""}</td>
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
        <p className="mt-1">The daily job scans about 550 stocks (S&amp;P 500, Nasdaq-100 and popular momentum names) for FVG setups and big movers. Results show here after the first run.</p>
      </Card>
    );
  }
  const items = scan.items || [];
  const list = view === "movers"
    ? items.filter((r) => !r.fund && r.ret20 != null && r.price >= 5).sort((a, b) => b.ret20 - a.ret20)
    : items.filter((r) => !r.fund && r.fvgStatus !== "None").sort((a, b) => (b.entryLive - a.entryLive) || (b.tech - a.tech) || ((b.ret20 || 0) - (a.ret20 || 0)));
  const rows = list.slice(0, more ? 75 : 15);
  const live = items.filter((r) => r.entryLive).length;
  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Radar" size={18} className="text-indigo-400" />Market scan</h2>
          <p className="text-sm text-slate-400">{scan.scanned} stocks scanned on {fmtDate((scan.generatedAt || "").slice(0, 10))} · {items.filter((r) => r.fvgStatus !== "None").length} with a bullish FVG · {live} live entries. Highlighted rows got the full check above.</p>
        </div>
        <Segmented label="Scan view" value={view} onChange={(v) => { setView(v); setMore(false); }}
          options={[{ value: "movers", label: "Top movers (1 mo)", icon: "Rocket" }, { value: "setups", label: "FVG setups", icon: "Crosshair" }]} />
      </div>
      <Card className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 text-right font-medium">Price</th>
            <th className="px-3 py-2.5 text-right font-medium">1 week</th><th className="px-3 py-2.5 text-right font-medium">1 month</th>
            <th className="px-3 py-2.5 text-right font-medium">3 months</th><th className="px-3 py-2.5 text-right font-medium">Volume vs avg</th>
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

function Picks({ scored, byTicker, scan, onOpen }) {
  const [sort, setSort] = useState("composite");
  const [horizon, setHorizon] = useState("all");
  const qualified = scored.filter((s) => s.composite >= L.RECOMMEND);
  const fits = (s) => horizon === "all" || (horizon === "swing" ? s.swingReady : s.positionReady);
  const shown = qualified.filter(fits);
  const top = sortBy(shown.filter((s) => s.composite >= L.HIGH_CONVICTION), sort);
  const mid = sortBy(shown.filter((s) => s.composite < L.HIGH_CONVICTION), sort);
  const swing = qualified.filter((s) => s.swingReady);
  const avg1m = swing.reduce((a, s) => a + s.upside1m, 0) / (swing.length || 1);
  const avg6m = qualified.reduce((a, s) => a + s.upside6m, 0) / (qualified.length || 1);
  const watch = sortBy(scored.filter((s) => s.composite >= L.WATCH && s.composite < L.RECOMMEND).filter(fits), sort);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Recommended" value={qualified.length} sub={"score ≥ " + L.RECOMMEND + " · " + scored.length + " fully checked" + (scan ? " of " + scan.scanned + " scanned" : "")} icon="ShieldCheck" />
        <Stat label="High conviction" value={qualified.filter((s) => s.composite >= L.HIGH_CONVICTION).length} sub={"score ≥ " + L.HIGH_CONVICTION} icon="Award" />
        <Stat label="Swing entries live" value={swing.length} sub={"avg 1-mo target " + spct(avg1m)} valueTone="up" icon="Zap" />
        <Stat label="Avg 6-mo upside" value={spct(avg6m)} sub="across recommended picks" valueTone="up" icon="CalendarRange" />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented options={HORIZONS} value={horizon} onChange={setHorizon} label="Filter by horizon" />
        <div className="flex items-center gap-2"><span className="hidden text-xs text-slate-400 xl:inline">Sort by</span><Segmented options={SORTS} value={sort} onChange={setSort} label="Sort picks" /></div>
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Award" size={18} className="text-indigo-400" />High Conviction Picks<span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-xs font-semibold text-indigo-300">{L.HIGH_CONVICTION}+</span></h2>
        <p className="mb-3 text-sm text-slate-400">HTF structure, valuation and the Street all lined up.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {top.map((s) => <InvestmentCard key={s.ticker} s={s} onOpen={onOpen} />)}
        </div>
        {top.length === 0 && <Card className="p-6 text-center text-sm text-slate-400">No high-conviction picks match this horizon right now.</Card>}
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Layers" size={18} className="text-emerald-400" />Recommended Buys<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">{L.RECOMMEND}–{L.HIGH_CONVICTION - 1}</span></h2>
        <p className="mb-3 text-sm text-slate-400">Pass the screen but miss full marks on at least one pillar.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {mid.map((s) => <InvestmentCard key={s.ticker} s={s} onOpen={onOpen} />)}
        </div>
        {mid.length === 0 && <Card className="p-6 text-center text-sm text-slate-400">Nothing in this band matches this horizon.</Card>}
      </div>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Icon name="Eye" size={18} className="text-amber-300" />Watchlist<span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">{L.WATCH}–{L.RECOMMEND - 1}</span></h2>
        <p className="mb-3 text-sm text-slate-400">Close, but not there yet. Click a row for the full breakdown.</p>
        {watch.length > 0 ? (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 font-medium">Score</th><th className="px-3 py-2.5 text-right font-medium">Price</th>
                <th className="px-3 py-2.5 font-medium">Setup</th><th className="px-3 py-2.5 text-right font-medium">1-mo target</th><th className="px-3 py-2.5 text-right font-medium">6-mo target</th><th className="px-3 py-2.5" />
              </tr></thead>
              <tbody>{watch.map((s) => <WatchRow key={s.ticker} s={s} onOpen={onOpen} />)}</tbody>
            </table>
          </Card>
        ) : <Card className="p-6 text-center text-sm text-slate-400">No stocks in this band right now.</Card>}
        <p className="mt-3 text-xs text-slate-500">{scored.filter((s) => s.composite < L.WATCH).length} fully-checked stocks scored below {L.WATCH} and are hidden.</p>
      </div>

      <MarketScan scan={scan} byTicker={byTicker} onOpen={onOpen} />
      <Methodology />
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
              {rows.map((t, i) => (
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
      </Card>
    </div>
  );
}

function Intelligence({ scored, byTicker, feedRes, txRes, onOpen }) {
  const [action, setAction] = useState("All");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("date");
  const items = feedRes.data.items;
  const rows = useMemo(() => {
    let r = items.filter((a) => action === "All" || a.action === action);
    const qq = q.trim().toUpperCase();
    if (qq) r = r.filter((a) => a.ticker.includes(qq) || a.firm.toUpperCase().includes(qq));
    const d = (a) => (a.oldTarget ? Math.abs(a.newTarget - a.oldTarget) / a.oldTarget : 0);
    return r.slice().sort((a, b) => (sort === "date" ? b.date.localeCompare(a.date) : d(b) - d(a)));
  }, [items, action, q, sort]);
  const counts = items.reduce((m, a) => ((m[a.action] = (m[a.action] || 0) + 1), m), {});
  const moves = items.filter((a) => a.oldTarget);
  const avgPt = moves.reduce((s, a) => s + (a.newTarget - a.oldTarget) / a.oldTarget, 0) / (moves.length || 1);
  const netInsider = txRes.data.items.reduce((a, t) => a + t.value, 0);
  const netBuyerCount = scored.filter((s) => s.insider.net > 0).length;

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

        <Card className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="border-b border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 font-medium">Rating firm</th><th className="px-3 py-2.5 font-medium">Action</th>
              <th className="px-3 py-2.5 font-medium">Price target shift</th><th className="px-3 py-2.5 font-medium">Headline / rationale</th><th className="px-3 py-2.5 font-medium">Insiders 90d</th><th className="px-4 py-2.5 font-medium">Source article</th>
            </tr></thead>
            <tbody>
              {rows.map((a, i) => {
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
        </Card>

        <div className="space-y-3 md:hidden">
          {rows.map((a, i) => {
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
        </div>
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
      {known && !err && <p className="mt-2 text-xs text-slate-400">{known.name} · {known.sector} · last {px(known.price)} · score {known.composite} · {PLAN_STATUS[known.plan.status][0]}</p>}
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

function RebalanceFeed({ a, onOpen }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="RefreshCw" size={15} className="text-indigo-300" />Smart rebalance recommendations</h3>
        <span className="text-xs text-slate-400">{a.feed.length} signals</span>
      </div>
      {a.feed.length === 0 && <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300"><Icon name="CircleCheck" size={16} />Balanced: no sector over {pct(L.CONCENTRATION_LIMIT, 0)} and every holding scores {L.REVIEW_SCORE}+.</div>}
      <div className="mt-3 space-y-2.5">
        {a.feed.map((f, i) => {
          if (f.type === "stop")
            return (
              <div key={i} className="rounded-lg border border-rose-500/40 bg-rose-500/15 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-rose-300"><Icon name="XCircle" size={15} />Stop breached: {f.ticker}</div>
                <p className="mt-1 text-sm text-slate-300">Price {px(f.price)} is under the {px(f.stop)} technical stop, so the FVG setup has failed. {pct(f.weight)} of the portfolio. Cut or re-plan the trade.</p>
              </div>
            );
          if (f.type === "concentration")
            return (
              <div key={i} className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-rose-300"><Icon name="AlertTriangle" size={15} />Over-concentrated: {f.sector} at {pct(f.weight)}</div>
                <p className="mt-1 text-sm text-slate-300">Trim about <span className="font-semibold text-white">{usd(f.excess)}</span> to bring {f.sector} back to {pct(L.CONCENTRATION_LIMIT, 0)}.{f.trimFirst.length > 0 && <> Lowest-scored to trim first: <span className="font-medium text-white">{f.trimFirst.join(", ")}</span>.</>}</p>
              </div>
            );
          if (f.type === "add")
            return (
              <div key={i} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><Icon name="TrendingUp" size={15} />Build {f.sector} ({pct(f.weight)} now)</div>
                  <button type="button" onClick={() => onOpen(f.stock.ticker)} className="flex items-center gap-2 rounded-md bg-slate-900/60 px-2 py-1 text-sm font-semibold text-white ring-1 ring-slate-700 hover:ring-indigo-500">{f.stock.ticker}<ScoreBadge score={f.stock.composite} size="sm" /></button>
                </div>
                <p className="mt-1 text-sm text-slate-300">
                  {f.stock.name}: {PLAN_STATUS[f.stock.plan.status][0].toLowerCase()}{f.stock.plan.status !== "none" ? " (FVG " + px(f.stock.fvg.lo) + "–" + px(f.stock.fvg.hi) + ", stop " + px(f.stock.stop) + ")" : ""}. 1-mo target {spct(f.stock.upside1m)}, 6-mo {spct(f.stock.upside6m)}.
                  {f.amount > 0 && <> Size ~<span className="font-semibold text-white">{usd(f.amount)}</span> (≈{f.shares} sh); scale in across the FVG or the {px(f.stock.buyZone[0])}–{px(f.stock.buyZone[1])} DCA zone.</>}
                </p>
              </div>
            );
          return (
            <div key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold text-amber-300"><Icon name="Flag" size={15} />Review holding: {f.ticker}</div><ScoreBadge score={f.score} size="sm" /></div>
              <p className="mt-1 text-sm text-slate-300">Score {f.score} is below the {L.REVIEW_SCORE} floor. {pct(f.weight)} of the portfolio, {f.pl >= 0 ? "up " : "down "}{usd(Math.abs(f.pl))} unrealized. Check its invalidation triggers before adding more.</p>
            </div>
          );
        })}
      </div>
      {a.feed.some((f) => f.type === "add") && <p className="mt-3 text-xs text-slate-500">Funding pool {usd(a.funding)} = trim proceeds {usd(a.trimProceeds)} + cash {usd(a.cash)}. Each underweight sector is built toward {pct(L.UNDERWEIGHT_FLOOR, 0)}, scaled to the pool.</p>}
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
  const flagged = r.score != null && r.score < L.REVIEW_SCORE;
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
      <td className="px-3 py-3">{r.stock ? <PlanPill s={r.stock} /> : r.scanOnly ? <span className="text-xs text-slate-400">Price only (not fully checked)</span> : r.unpriced ? <span className="text-xs text-amber-300">No price data yet (held at cost)</span> : <span className="text-slate-500">—</span>}</td>
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

function PortfolioTab({ scored, byTicker, scan, onOpen }) {
  const { holdings, addHolding, updateHolding, deleteHolding, resetPortfolio, sync } = usePortfolio();
  const priceBook = useMemo(() => Object.fromEntries(((scan && scan.items) || []).map((r) => [r.ticker, r])), [scan]);
  const a = useMemo(() => analyzePortfolio(holdings, byTicker, SECTORS, SECTOR_COLORS, priceBook), [holdings, byTicker, priceBook]);
  const rows = a.rows.slice().sort((x, y) => y.value - x.value);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total portfolio value" value={usd(a.total)} sub={rows.length + " positions incl. cash"} icon="Briefcase" />
        <Stat label="Overall P/L" value={usd(a.pl)} sub={"on " + usd(a.costTotal) + " cost basis"} valueTone={a.pl >= 0 ? "up" : "down"} icon={a.pl >= 0 ? "TrendingUp" : "TrendingDown"} />
        <Stat label="Portfolio beta vs SPY" value={a.beta.toFixed(2)} sub={a.beta > 1.1 ? "more volatile than SPY" : a.beta < 0.9 ? "less volatile than SPY" : "close to SPY"} icon="Gauge" />
        <Stat label="Overall P/L %" value={spct(a.plPct)} sub="unrealized, excludes cash" valueTone={a.plPct >= 0 ? "up" : "down"} icon="Percent" />
      </div>
      <HoldingForm byTicker={byTicker} scored={scored} priceBook={priceBook} onAdd={addHolding} />
      <SyncCard sync={sync} />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <AllocationChart sectors={a.sectors} total={a.total} />
        <RebalanceFeed a={a} onOpen={onOpen} />
      </div>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Icon name="Layers" size={15} className="text-indigo-300" />Holdings</h3>
          <button type="button" onClick={resetPortfolio} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"><Icon name="RotateCcw" size={12} />Reset to sample</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead><tr className="border-y border-slate-700/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Ticker</th><th className="px-3 py-2.5 text-right font-medium">Shares</th><th className="px-3 py-2.5 text-right font-medium">Avg cost</th>
              <th className="px-3 py-2.5 text-right font-medium">Price</th><th className="px-3 py-2.5 text-right font-medium">Value</th><th className="px-3 py-2.5 text-right font-medium">P/L</th>
              <th className="px-3 py-2.5 font-medium">FVG setup</th><th className="px-3 py-2.5 text-right font-medium">Weight</th><th className="px-3 py-2.5 font-medium">Score</th>
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
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    ref.current && ref.current.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!s) return null;
  const verdict = s.composite >= L.HIGH_CONVICTION ? ["High Conviction Buy", "text-emerald-300 bg-emerald-500/15"]
    : s.composite >= L.RECOMMEND ? ["Recommended Buy", "text-emerald-300 bg-emerald-500/10"]
    : s.composite >= L.REVIEW_SCORE ? ["Watchlist", "text-slate-300 bg-slate-700"] : ["Avoid / Review", "text-rose-300 bg-rose-500/15"];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={s.ticker + " score breakdown"} onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-800 p-5 shadow-2xl focus:outline-none sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
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
        <div className="mt-3 flex flex-wrap gap-1.5"><PlanPill s={s} /><FvgPill fvg={s.fvg} /></div>
        <div className="mt-3"><AiTake s={s} full /></div>
        <div className="mt-3"><TradePlan s={s} /></div>
        <div className="mt-4"><BuyZone s={s} /></div>
        <div className="mt-5 space-y-4">
          {PILLARS.map((p) => (
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
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-slate-700 bg-slate-800 p-5 shadow-2xl focus:outline-none">
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
  { id: "picks", label: "Swing & Position Picks", short: "Picks", icon: "Target" },
  { id: "intelligence", label: "Analyst & Insider Intelligence", short: "Intel", icon: "Newspaper" },
  { id: "portfolio", label: "Portfolio Tracker & Rebalancer", short: "Portfolio", icon: "Briefcase" },
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
  // Never blend sample analyst/insider rows into real stock data: if the screener is live but a feed fell back to samples, show it empty.
  const liveScreener = screener.source !== "mock";
  const blank = (r, msg) => ({ ...r, data: { ...r.data, items: [] }, notes: [msg, ...(r.notes || [])] });
  const feed = useMemo(() => (liveScreener && feedRaw.source === "mock" ? blank(feedRaw, "No live analyst data yet: add a Finnhub or FMP key") : feedRaw), [liveScreener, feedRaw]);
  const insider = useMemo(() => (liveScreener && insiderRaw.source === "mock" ? blank(insiderRaw, "No live insider data (Finnhub insider endpoint may need a paid plan)") : insiderRaw), [liveScreener, insiderRaw]);

  const scored = useMemo(() => scoreUniverse(screener.data.stocks, screener.data.sectorPE, insider.data.items), [screener.data, insider.data]);
  const byTicker = useMemo(() => Object.fromEntries(scored.map((s) => [s.ticker, s])), [scored]);

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
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500"><Icon name="Landmark" size={18} className="text-white" /></div>
              <div className="min-w-0">
                <h1 className="text-base font-bold leading-tight text-white sm:text-lg">Wealth &amp; Stock Intelligence Engine</h1>
                <div className="text-[11px] leading-tight text-slate-400">HTF FVG setups · Valuation · Street + insiders · as of {fmtDate(screener.data.asOf || new Date().toISOString().slice(0, 10))}</div>
              </div>
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
        {tab === "intelligence" && <Intelligence scored={scored} byTicker={byTicker} feedRes={feed} txRes={insider} onOpen={setOpen} />}
        {tab === "portfolio" && <PortfolioTab scored={scored} byTicker={byTicker} scan={screener.source !== "mock" ? scanRes.data : null} onOpen={setOpen} />}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-slate-500 sm:px-6">
        {live ? "Screener data: " + SOURCE_LABEL[src] + ". FVG zones, stops and targets are computed from daily candles by the rules in the methodology panel."
          : "Prices, FVG zones, targets, analyst actions and insider trades are illustrative sample data."} Scores are a screening aid, not investment advice.
      </footer>

      {open && byTicker[open] && <StockModal s={byTicker[open]} onClose={close} />}
      {drawer && <SettingsDrawer settings={settings} status={{ screener, feed, insider }} onClose={closeDrawer}
        onSave={(next) => { setSettings({ ...next }); setDrawer(false); }} />}
    </div>
  );
}
