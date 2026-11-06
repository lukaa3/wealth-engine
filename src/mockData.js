/**
 * mockData.js — rich sample data so every metric renders out of the box.
 * All values are ILLUSTRATIVE (not live quotes, filings or real rating changes).
 * Shapes here are the same shapes api.js normalizes live database rows into.
 */

export const SECTORS = ["Technology", "Financials", "Healthcare", "Consumer", "Energy", "Other", "Cash"];

export const SECTOR_COLORS = {
  Technology: "#3987e5",
  Financials: "#d95926",
  Healthcare: "#199e70",
  Consumer: "#c98500",
  Energy: "#d55181",
  Other: "#9085e9", // live tickers outside the five core sectors
  Cash: "#94a3b8",
};

/** Forward P/E medians used for the "discount to sector" test. */
export const SECTOR_PE = { Technology: 28, Financials: 15, Healthcare: 18, Consumer: 21, Energy: 13, Other: 20 };

/*
 * Stock fields
 *  price, beta
 *  Valuation:  dcfValue, peg, fwdPE
 *  Technical:  fvg { tf: "Weekly"|"Daily", status: "Rejected"|"Testing"|"None", lo, hi }  (bullish FVG = entry zone)
 *              fib (deepest Fibonacci retracement price is reacting from), support (key structural support confluence)
 *  Trade plan: stop (invalidation below the FVG), target1m (~1-month swing target), target6m (~6-month target)
 *  Street:     target12m (consensus PT), buyPct, analystCount
 *  Longer hold: buyZone [low, high] for DCA accumulation
 *  catalysts[], invalidation[]  (a technical stop line is added automatically)
 *  Insider 90-day net flow is derived from insiderTransactions below.
 */
const F = (tf, status, lo, hi) => ({ tf, status, lo, hi });
const NONE = { tf: null, status: "None", lo: null, hi: null };

export const stocks = [
  // ---------------- Technology ----------------
  { ticker: "NVDA", name: "NVIDIA Corp.", sector: "Technology", price: 182.4, beta: 1.75,
    dcfValue: 236, peg: 0.82, fwdPE: 27.0, fvg: F("Weekly", "Rejected", 168, 174), fib: 0.618, support: true,
    stop: 164, target1m: 200, target6m: 225, target12m: 238, buyPct: 0.9, analystCount: 62, buyZone: [160, 180],
    catalysts: ["Data-center backlog extends into 2H27", "Networking + software attach broadening revenue", "Next-gen platform ramp in Q1"],
    invalidation: ["Hyperscaler capex guide cuts", "Gross margin below 70%"] },
  { ticker: "ADBE", name: "Adobe Inc.", sector: "Technology", price: 420.0, beta: 1.2,
    dcfValue: 560, peg: 0.95, fwdPE: 19.0, fvg: F("Weekly", "Rejected", 395, 408), fib: 0.786, support: false,
    stop: 388, target1m: 462, target6m: 510, target12m: 540, buyPct: 0.71, analystCount: 34, buyZone: [380, 430],
    catalysts: ["Firefly AI tools lifting Creative Cloud pricing", "Earnings in December: low bar after de-rating", "Buyback retiring ~3% of shares a year"],
    invalidation: ["Net new ARR turning negative", "AI-native competitors taking share in core seats"] },
  { ticker: "GOOGL", name: "Alphabet Inc.", sector: "Technology", price: 175.0, beta: 1.05,
    dcfValue: 225, peg: 1.05, fwdPE: 20.0, fvg: F("Daily", "Rejected", 168, 171), fib: 0.618, support: true,
    stop: 164, target1m: 192, target6m: 210, target12m: 215, buyPct: 0.82, analystCount: 56, buyZone: [155, 175],
    catalysts: ["Cloud margin expansion", "AI Overviews monetizing at parity with search", "Waymo expansion headlines"],
    invalidation: ["Search revenue growth below 5%", "Adverse search-remedies ruling"] },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "Technology", price: 148.2, beta: 1.95,
    dcfValue: 196, peg: 0.74, fwdPE: 24.0, fvg: F("Weekly", "Rejected", 136, 142), fib: 0.786, support: false,
    stop: 132, target1m: 165, target6m: 185, target12m: 192, buyPct: 0.78, analystCount: 48, buyZone: [130, 145],
    catalysts: ["AI accelerator wins beyond hyperscalers", "Server CPU share gains", "Analyst day targets in December"],
    invalidation: ["Accelerator revenue guide cut", "PC/console inventory correction"] },
  { ticker: "CRM", name: "Salesforce Inc.", sector: "Technology", price: 255.1, beta: 1.2,
    dcfValue: 318, peg: 1.1, fwdPE: 24.0, fvg: F("Daily", "Rejected", 243, 249), fib: 0.618, support: false,
    stop: 238, target1m: 280, target6m: 305, target12m: 320, buyPct: 0.72, analystCount: 51, buyZone: [235, 255],
    catalysts: ["Agentic AI add-on attach rates", "Margin expansion + buybacks", "Q3 earnings early December"],
    invalidation: ["cRPO growth below 8%", "Large dilutive acquisition"] },
  { ticker: "AVGO", name: "Broadcom Inc.", sector: "Technology", price: 340.0, beta: 1.3,
    dcfValue: 372, peg: 1.35, fwdPE: 33.0, fvg: F("Weekly", "Testing", 318, 331), fib: 0.5, support: true,
    stop: 310, target1m: 362, target6m: 390, target12m: 410, buyPct: 0.88, analystCount: 40, buyZone: [300, 330],
    catalysts: ["Custom AI chip programs with hyperscalers", "VMware cross-sell"],
    invalidation: ["Loss of a top custom-silicon customer", "Leverage rising after another deal"] },
  { ticker: "MSFT", name: "Microsoft Corp.", sector: "Technology", price: 412.3, beta: 0.92,
    dcfValue: 470, peg: 1.9, fwdPE: 31.0, fvg: F("Daily", "Testing", 401, 408), fib: 0.5, support: true,
    stop: 395, target1m: 435, target6m: 470, target12m: 500, buyPct: 0.86, analystCount: 58, buyZone: [380, 405],
    catalysts: ["Azure AI workloads", "Copilot seat monetization"],
    invalidation: ["Azure growth below 20%", "Capex outpacing cloud revenue"] },
  { ticker: "AAPL", name: "Apple Inc.", sector: "Technology", price: 228.0, beta: 1.1,
    dcfValue: 205, peg: 2.6, fwdPE: 32.0, fvg: NONE, fib: null, support: true,
    stop: null, target1m: 235, target6m: 240, target12m: 245, buyPct: 0.62, analystCount: 44, buyZone: [195, 210],
    catalysts: ["Services mix lifting margins", "On-device AI upgrade cycle"],
    invalidation: ["Services growth below 8%", "App Store fee rulings"] },
  // ---------------- Financials ----------------
  { ticker: "GS", name: "Goldman Sachs Group", sector: "Financials", price: 720.0, beta: 1.35,
    dcfValue: 905, peg: 0.95, fwdPE: 13.2, fvg: F("Weekly", "Rejected", 684, 702), fib: 0.705, support: false,
    stop: 672, target1m: 790, target6m: 850, target12m: 905, buyPct: 0.77, analystCount: 26, buyZone: [660, 710],
    catalysts: ["M&A and IPO pipeline rebuilding", "Trading share gains", "Asset & wealth fee mix rising"],
    invalidation: ["Deal activity stalls into year-end", "ROTE back below 12%"] },
  { ticker: "SCHW", name: "Charles Schwab Corp.", sector: "Financials", price: 88.0, beta: 0.95,
    dcfValue: 112, peg: 0.88, fwdPE: 16.5, fvg: F("Daily", "Rejected", 84.5, 86.2), fib: 0.618, support: true,
    stop: 82.8, target1m: 96, target6m: 104, target12m: 108, buyPct: 0.8, analystCount: 22, buyZone: [80, 88],
    catalysts: ["Cash-sorting headwind fading", "Monthly asset-gathering data", "Buybacks restarting"],
    invalidation: ["Client cash balances falling again", "Net new assets slowing"] },
  { ticker: "COF", name: "Capital One Financial", sector: "Financials", price: 205.0, beta: 1.4,
    dcfValue: 228, peg: 1.25, fwdPE: 11.5, fvg: F("Daily", "Testing", 198, 202), fib: null, support: true,
    stop: 195, target1m: 220, target6m: 235, target12m: 245, buyPct: 0.74, analystCount: 24, buyZone: [190, 205],
    catalysts: ["Discover integration synergies", "Network economics on debit volume"],
    invalidation: ["Card charge-offs rising", "Integration cost overruns"] },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", sector: "Financials", price: 298.0, beta: 1.05,
    dcfValue: 340, peg: 1.6, fwdPE: 14.5, fvg: F("Daily", "Testing", 289, 294), fib: 0.5, support: true,
    stop: 284, target1m: 312, target6m: 325, target12m: 330, buyPct: 0.68, analystCount: 27, buyZone: [270, 290],
    catalysts: ["Investment banking fee recovery", "Fortress balance sheet"],
    invalidation: ["NII guide cut on faster rate cuts", "Credit reserve builds"] },
  // ---------------- Healthcare ----------------
  { ticker: "ABBV", name: "AbbVie Inc.", sector: "Healthcare", price: 205.0, beta: 0.55,
    dcfValue: 255, peg: 0.95, fwdPE: 15.5, fvg: F("Daily", "Rejected", 196, 200), fib: 0.705, support: true,
    stop: 192, target1m: 222, target6m: 240, target12m: 258, buyPct: 0.79, analystCount: 29, buyZone: [185, 205],
    catalysts: ["Skyrizi + Rinvoq beating Humira erosion", "Neuroscience launches", "Pipeline readouts in Q1"],
    invalidation: ["Immunology growth below 10%", "Drug-pricing policy hit"] },
  { ticker: "LLY", name: "Eli Lilly & Co.", sector: "Healthcare", price: 795.0, beta: 0.45,
    dcfValue: 940, peg: 0.9, fwdPE: 30.0, fvg: F("Weekly", "Rejected", 752, 776), fib: 0.618, support: true,
    stop: 738, target1m: 870, target6m: 950, target12m: 1010, buyPct: 0.82, analystCount: 33, buyZone: [720, 790],
    catalysts: ["Incretin supply ramp", "Oral GLP-1 approval path", "Weekly prescription data"],
    invalidation: ["GLP-1 price cuts beyond guidance", "Manufacturing delays"] },
  { ticker: "UNH", name: "UnitedHealth Group", sector: "Healthcare", price: 330.0, beta: 0.6,
    dcfValue: 410, peg: 1.05, fwdPE: 15.0, fvg: F("Weekly", "Testing", 312, 324), fib: 0.786, support: true,
    stop: 305, target1m: 360, target6m: 390, target12m: 400, buyPct: 0.7, analystCount: 27, buyZone: [300, 330],
    catalysts: ["Medical cost trend stabilizing", "2027 Medicare Advantage rates", "Insider buying after drawdown"],
    invalidation: ["Medical loss ratio above 89%", "Adverse federal investigation outcome"] },
  { ticker: "ISRG", name: "Intuitive Surgical", sector: "Healthcare", price: 520.0, beta: 1.1,
    dcfValue: 610, peg: 1.7, fwdPE: 55.0, fvg: F("Daily", "Rejected", 502, 512), fib: 0.786, support: true,
    stop: 494, target1m: 565, target6m: 600, target12m: 614, buyPct: 0.8, analystCount: 30, buyZone: [470, 515],
    catalysts: ["da Vinci 5 placements", "Procedure growth mid-teens"],
    invalidation: ["Procedure growth below 12%", "Hospital capex freeze"] },
  { ticker: "PFE", name: "Pfizer Inc.", sector: "Healthcare", price: 26.0, beta: 0.55,
    dcfValue: 27, peg: 2.4, fwdPE: 8.5, fvg: NONE, fib: null, support: false,
    stop: null, target1m: 27, target6m: 27.5, target12m: 28.5, buyPct: 0.4, analystCount: 25, buyZone: [22, 25],
    catalysts: ["Cost-cut program", "Oncology pipeline"],
    invalidation: ["Dividend not covered by FCF", "Pipeline misses"] },
  // ---------------- Consumer ----------------
  { ticker: "MNST", name: "Monster Beverage", sector: "Consumer", price: 54.0, beta: 0.75,
    dcfValue: 70, peg: 0.95, fwdPE: 28.0, fvg: F("Weekly", "Rejected", 50.8, 52.6), fib: 0.618, support: true,
    stop: 49.6, target1m: 59.5, target6m: 66, target12m: 70, buyPct: 0.76, analystCount: 25, buyZone: [48, 54],
    catalysts: ["International share gains", "Margin recovery as aluminum eases", "Debt-free buybacks"],
    invalidation: ["US category volumes declining", "Gross margin below 52%"] },
  { ticker: "PEP", name: "PepsiCo Inc.", sector: "Consumer", price: 142.0, beta: 0.5,
    dcfValue: 172, peg: 1.15, fwdPE: 17.0, fvg: F("Daily", "Rejected", 137, 140), fib: 0.618, support: false,
    stop: 134.5, target1m: 152, target6m: 160, target12m: 165, buyPct: 0.55, analystCount: 24, buyZone: [132, 142],
    catalysts: ["Activist-driven portfolio review", "Snack volume stabilizing"],
    invalidation: ["North America volumes keep falling", "Dividend growth slowing"] },
  { ticker: "PG", name: "Procter & Gamble", sector: "Consumer", price: 158.0, beta: 0.4,
    dcfValue: 172, peg: 2.2, fwdPE: 21.5, fvg: F("Daily", "Testing", 154, 156.5), fib: 0.5, support: true,
    stop: 151.5, target1m: 166, target6m: 172, target12m: 178, buyPct: 0.6, analystCount: 22, buyZone: [145, 155],
    catalysts: ["Pricing power", "Productivity savings"],
    invalidation: ["Organic volume negative", "Private-label share gains"] },
  { ticker: "COST", name: "Costco Wholesale", sector: "Consumer", price: 905.0, beta: 0.8,
    dcfValue: 760, peg: 3.8, fwdPE: 48.0, fvg: NONE, fib: null, support: true,
    stop: null, target1m: 930, target6m: 960, target12m: 1050, buyPct: 0.66, analystCount: 31, buyZone: [780, 850],
    catalysts: ["Membership renewals above 90%", "Monthly comp sales"],
    invalidation: ["Renewal rate below 89%", "Multiple compression"] },
  // ---------------- Energy ----------------
  { ticker: "FANG", name: "Diamondback Energy", sector: "Energy", price: 142.0, beta: 1.2,
    dcfValue: 192, peg: 0.7, fwdPE: 9.8, fvg: F("Weekly", "Rejected", 133, 138), fib: 0.618, support: false,
    stop: 129, target1m: 158, target6m: 172, target12m: 185, buyPct: 0.74, analystCount: 28, buyZone: [128, 142],
    catalysts: ["Permian well productivity", "Buybacks at a top-decile FCF yield", "Low-cost inventory depth"],
    invalidation: ["WTI below $55 for weeks", "Well productivity declining"] },
  { ticker: "SLB", name: "SLB (Schlumberger)", sector: "Energy", price: 37.0, beta: 1.15,
    dcfValue: 47, peg: 0.85, fwdPE: 11.5, fvg: F("Daily", "Rejected", 35.2, 36.1), fib: 0.618, support: true,
    stop: 34.4, target1m: 41, target6m: 44, target12m: 48, buyPct: 0.79, analystCount: 30, buyZone: [34, 37],
    catalysts: ["International offshore cycle", "Digital segment margins"],
    invalidation: ["International rig count rolling over", "Middle East contract delays"] },
  { ticker: "XOM", name: "Exxon Mobil Corp.", sector: "Energy", price: 116.0, beta: 0.85,
    dcfValue: 128, peg: 1.8, fwdPE: 14.0, fvg: F("Daily", "Testing", 113, 115), fib: 0.5, support: true,
    stop: 111, target1m: 122, target6m: 126, target12m: 130, buyPct: 0.55, analystCount: 26, buyZone: [105, 112],
    catalysts: ["Permian synergies", "Low-carbon optionality"],
    invalidation: ["Refining margins collapsing", "Upstream costs rising"] },
  { ticker: "OXY", name: "Occidental Petroleum", sector: "Energy", price: 44.0, beta: 1.3,
    dcfValue: 50, peg: 1.4, fwdPE: 14.0, fvg: NONE, fib: null, support: false,
    stop: null, target1m: 46, target6m: 48, target12m: 52, buyPct: 0.45, analystCount: 24, buyZone: [38, 42],
    catalysts: ["Debt reduction", "Direct air capture"],
    invalidation: ["Leverage not falling below 2x", "Chemicals downturn"] },
];

/* --------------------------- Analyst rating feed --------------------------- */
export const SOURCE_URLS = {
  "Yahoo Finance": (t) => `https://finance.yahoo.com/quote/${t.replace(".", "-")}/analysis/`,
  Bloomberg: (t) => `https://www.bloomberg.com/quote/${t.replace(".", "/")}:US`,
  Reuters: (t) => `https://www.reuters.com/site-search/?query=${encodeURIComponent(t)}`,
  MarketWatch: (t) => `https://www.marketwatch.com/investing/stock/${t.toLowerCase()}/analystestimates`,
  Nasdaq: (t) => `https://www.nasdaq.com/market-activity/stocks/${t.toLowerCase()}/analyst-research`,
};

export const analystFeed = [
  { date: "2026-11-05", ticker: "NVDA", firm: "Morgan Stanley", action: "PT Raise", fromRating: "Overweight", toRating: "Overweight", oldTarget: 215, newTarget: 245, rationale: "Data-center backlog extends into 2H27; gross-margin guide ahead of street.", source: "Bloomberg" },
  { date: "2026-11-05", ticker: "FANG", firm: "Goldman Sachs", action: "Upgrade", fromRating: "Neutral", toRating: "Buy", oldTarget: 160, newTarget: 190, rationale: "Permian well productivity + buyback pace; FCF yield screens top-decile.", source: "Reuters" },
  { date: "2026-11-04", ticker: "AAPL", firm: "Jefferies", action: "Downgrade", fromRating: "Buy", toRating: "Hold", oldTarget: 260, newTarget: 230, rationale: "Handset cycle softer than modeled; services growth decelerating.", source: "Yahoo Finance" },
  { date: "2026-11-04", ticker: "LLY", firm: "BofA Securities", action: "PT Raise", fromRating: "Buy", toRating: "Buy", oldTarget: 950, newTarget: 1040, rationale: "Incretin supply ramp ahead of plan; oral GLP-1 readout de-risks pipeline.", source: "MarketWatch" },
  { date: "2026-11-03", ticker: "GS", firm: "Wells Fargo", action: "PT Raise", fromRating: "Overweight", toRating: "Overweight", oldTarget: 820, newTarget: 920, rationale: "Advisory pipeline rebuild + trading share gains; ROTE path to 16%.", source: "Bloomberg" },
  { date: "2026-11-03", ticker: "PG", firm: "Barclays", action: "PT Cut", fromRating: "Equal Weight", toRating: "Equal Weight", oldTarget: 185, newTarget: 172, rationale: "Volume weakness in Beauty; FX headwind widened for the FY guide.", source: "Reuters" },
  { date: "2026-11-02", ticker: "ADBE", firm: "Bernstein", action: "Upgrade", fromRating: "Market Perform", toRating: "Outperform", oldTarget: 450, newTarget: 560, rationale: "AI disruption fears overdone; under 20x forward earnings prices in no growth.", source: "Yahoo Finance" },
  { date: "2026-11-02", ticker: "AMD", firm: "Bernstein", action: "Upgrade", fromRating: "Market Perform", toRating: "Outperform", oldTarget: 160, newTarget: 195, rationale: "Accelerator wins broaden customer base beyond hyperscalers.", source: "Yahoo Finance" },
  { date: "2026-10-31", ticker: "MNST", firm: "Evercore ISI", action: "Initiate", fromRating: "—", toRating: "Outperform", oldTarget: null, newTarget: 72, rationale: "International share gains; margin recovery as aluminum costs ease.", source: "Nasdaq" },
  { date: "2026-10-31", ticker: "XOM", firm: "Citi", action: "Downgrade", fromRating: "Buy", toRating: "Neutral", oldTarget: 140, newTarget: 126, rationale: "Valuation full vs peers after run; downstream margins normalizing.", source: "Bloomberg" },
  { date: "2026-10-30", ticker: "ABBV", firm: "UBS", action: "PT Raise", fromRating: "Buy", toRating: "Buy", oldTarget: 235, newTarget: 262, rationale: "Immunology franchise more than offsetting biosimilar erosion.", source: "MarketWatch" },
  { date: "2026-10-30", ticker: "SLB", firm: "Piper Sandler", action: "Upgrade", fromRating: "Neutral", toRating: "Overweight", oldTarget: 41, newTarget: 49, rationale: "International offshore cycle + digital segment margin inflection.", source: "Reuters" },
  { date: "2026-10-29", ticker: "CRM", firm: "KeyBanc", action: "PT Raise", fromRating: "Overweight", toRating: "Overweight", oldTarget: 300, newTarget: 330, rationale: "Agentic AI attach rates tracking above checks; cRPO beat.", source: "Yahoo Finance" },
  { date: "2026-10-28", ticker: "JPM", firm: "Raymond James", action: "Downgrade", fromRating: "Strong Buy", toRating: "Outperform", oldTarget: 340, newTarget: 325, rationale: "NII sensitivity to rate cuts; reserve build risk into 2027.", source: "Nasdaq" },
  { date: "2026-10-28", ticker: "SCHW", firm: "Truist", action: "Upgrade", fromRating: "Hold", toRating: "Buy", oldTarget: 90, newTarget: 110, rationale: "Cash-sorting headwind fading; asset gathering re-accelerating.", source: "Bloomberg" },
  { date: "2026-10-27", ticker: "COST", firm: "JPMorgan", action: "Downgrade", fromRating: "Overweight", toRating: "Neutral", oldTarget: 1100, newTarget: 980, rationale: "Valuation stretched; membership-fee tailwind largely priced in.", source: "MarketWatch" },
  { date: "2026-10-27", ticker: "UNH", firm: "Morgan Stanley", action: "Upgrade", fromRating: "Equal Weight", toRating: "Overweight", oldTarget: 350, newTarget: 405, rationale: "Medical cost trend stabilizing; 2027 Medicare Advantage rates supportive.", source: "Reuters" },
  { date: "2026-10-24", ticker: "MSFT", firm: "Goldman Sachs", action: "Reiterate", fromRating: "Buy", toRating: "Buy", oldTarget: 500, newTarget: 510, rationale: "Azure capacity adds; Copilot monetization still early.", source: "Yahoo Finance" },
  { date: "2026-10-23", ticker: "PFE", firm: "Citi", action: "PT Cut", fromRating: "Neutral", toRating: "Neutral", oldTarget: 31, newTarget: 28, rationale: "Patent cliff exposure through 2028; pipeline replacement uncertain.", source: "Nasdaq" },
];

/* --------------------- Insider transactions (90 days, Form 4) --------------------- */
// Role-level only (no names). value in USD; positive = open-market buy, negative = sale.
export const insiderTransactions = [
  { date: "2026-11-04", ticker: "UNH", role: "CEO", shares: 9100, value: 3000000, planned: false },
  { date: "2026-11-03", ticker: "SCHW", role: "CEO", shares: 17000, value: 1500000, planned: false },
  { date: "2026-11-01", ticker: "ADBE", role: "CEO", shares: 1900, value: 800000, planned: false },
  { date: "2026-10-30", ticker: "NVDA", role: "Director", shares: 247000, value: -45000000, planned: true },
  { date: "2026-10-29", ticker: "ABBV", role: "Director", shares: 7300, value: 1500000, planned: false },
  { date: "2026-10-28", ticker: "MNST", role: "Co-CEO", shares: 20400, value: 1100000, planned: false },
  { date: "2026-10-27", ticker: "UNH", role: "CFO", shares: 3000, value: 1000000, planned: false },
  { date: "2026-10-26", ticker: "FANG", role: "Director", shares: 5600, value: 800000, planned: false },
  { date: "2026-10-24", ticker: "LLY", role: "10% Owner (foundation)", shares: 75500, value: -60000000, planned: true },
  { date: "2026-10-22", ticker: "AAPL", role: "CEO", shares: 131000, value: -30000000, planned: true },
  { date: "2026-10-21", ticker: "SCHW", role: "Director", shares: 6800, value: 600000, planned: false },
  { date: "2026-10-20", ticker: "GS", role: "President", shares: 34700, value: -25000000, planned: false },
  { date: "2026-10-18", ticker: "SLB", role: "EVP", shares: 30000, value: 1100000, planned: false },
  { date: "2026-10-17", ticker: "AVGO", role: "CEO", shares: 58800, value: -20000000, planned: true },
  { date: "2026-10-16", ticker: "ADBE", role: "Director", shares: 950, value: 400000, planned: false },
  { date: "2026-10-15", ticker: "AMD", role: "CEO", shares: 54000, value: -8000000, planned: true },
  { date: "2026-10-14", ticker: "JPM", role: "CEO", shares: 50300, value: -15000000, planned: true },
  { date: "2026-10-10", ticker: "MSFT", role: "EVP", shares: 29100, value: -12000000, planned: true },
  { date: "2026-10-08", ticker: "COST", role: "EVP", shares: 11000, value: -10000000, planned: false },
  { date: "2026-10-06", ticker: "GOOGL", role: "Director", shares: 45700, value: -8000000, planned: true },
  { date: "2026-10-03", ticker: "CRM", role: "Co-founder / CEO", shares: 11800, value: -3000000, planned: true },
  { date: "2026-09-29", ticker: "ISRG", role: "EVP", shares: 3800, value: -2000000, planned: true },
  { date: "2026-09-22", ticker: "PG", role: "CEO", shares: 12700, value: -2000000, planned: true },
  { date: "2026-09-18", ticker: "PEP", role: "Director", shares: 1400, value: 200000, planned: false },
  { date: "2026-09-11", ticker: "XOM", role: "SVP", shares: 8600, value: -1000000, planned: true },
  { date: "2026-09-04", ticker: "COF", role: "Director", shares: 2400, value: -500000, planned: false },
  { date: "2026-08-21", ticker: "PFE", role: "Director", shares: 7700, value: 200000, planned: false },
];

export const insiderSourceUrl = (t) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(t)}&type=4&dateb=&owner=include&count=40`;

/* ------------------------------ Sample portfolio ------------------------------ */
export const samplePortfolio = [
  { id: "h1", ticker: "NVDA", shares: 120, cost: 98.0 },
  { id: "h2", ticker: "MSFT", shares: 40, cost: 330.0 },
  { id: "h3", ticker: "AAPL", shares: 80, cost: 175.0 },
  { id: "h4", ticker: "AVGO", shares: 30, cost: 210.0 },
  { id: "h5", ticker: "JPM", shares: 25, cost: 210.0 },
  { id: "h6", ticker: "PG", shares: 40, cost: 150.0 },
  { id: "h7", ticker: "XOM", shares: 50, cost: 105.0 },
  { id: "h8", ticker: "CASH", shares: 9000, cost: 1 },
];

export const mockData = {
  sectors: SECTORS,
  sectorColors: SECTOR_COLORS,
  sectorPE: SECTOR_PE,
  stocks,
  analystFeed,
  insiderTransactions,
  samplePortfolio,
  asOf: "2026-11-05",
};
