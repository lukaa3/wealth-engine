# Wealth & Stock Intelligence Engine

A swing + position stock screener: HTF bullish FVG setups, valuation, analyst consensus and insider flow.
React + Tailwind CSS v4 + Lucide React, built with Vite, hosted free on **GitHub Pages**.

It always works out of the box on sample data (`src/mockData.js`). Add free API keys and/or a scheduled
GitHub Action to switch to live data.

## How data reaches the page

```
GitHub Action (weekdays after the close)            Visitor's browser
  scripts/update-screener.mjs                          src/api.js tries, in order:
   ├─ FMP / Finnhub / Alpha Vantage  ──►  scores ──┐     1. Supabase (if configured)
   ├─ writes public/data/*.json ─────────────────► │     2. ./data/*.json  (deployed with the site)
   └─ upserts Supabase (optional) ───────────────► │     3. Live API calls with keys from the Settings drawer
                                                   └──►  4. mockData.js sample data
```

The header chip shows which source is active; click it to open **Settings**.

## 1. Run locally
```bash
npm install
npm run dev            # sample data
cp .env.example .env.local   # optional: add keys for local testing
```

## 2. Put it on GitHub Pages
1. Create a GitHub repo and push this folder to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The `Update data & deploy` workflow builds and publishes on every push. Your site appears at
   `https://<your-username>.github.io/<repo>/`.

## 3. Turn on live data (free)
Get free keys: [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) ·
[Finnhub](https://finnhub.io/register) · [Alpha Vantage](https://www.alphavantage.co/support/#api-key).
One is enough; FMP covers the most (quotes, DCF, price targets, analyst grades, daily candles).

**Option A: scheduled job (recommended).** Repo **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|---|---|---|
| Secret | `FMP_API_KEY` | your FMP key |
| Secret | `FINNHUB_API_KEY` | optional |
| Secret | `ALPHA_VANTAGE_API_KEY` | optional |
| Variable | `WATCHLIST` | optional, e.g. `NVDA,APP,LLY,SCHW` (default: the 25 sample tickers) |

Then **Actions → Update data & deploy → Run workflow**. It refreshes `public/data/*.json`, commits it, and deploys.
After that it runs automatically every weekday after the close. Your keys stay secret; visitors just get the JSON.

**Add the free AI analyst take (optional).** The same Action can ask a free-tier AI to write a short note on the
top-scored stocks (verdict, 2-sentence summary, bull/bear case, the level to watch). It only sees the numbers and
headlines the app already has, and is told not to add outside facts. Pick one:

| Provider | Get a key | Secret name | Notes |
|---|---|---|---|
| Groq (default) | [console.groq.com/keys](https://console.groq.com/keys) | `GROQ_API_KEY` | Free plan; default model `openai/gpt-oss-120b` |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | Free tier on Flash / Flash-Lite; free-tier prompts may be used by Google to improve its products |

Optional variables: `AI_PROVIDER` (`groq` / `gemini`), `AI_MODEL` (override the model), `AI_MAX_STOCKS` (default 15).
The job paces requests (about one every 8 s on Groq) to stay under free per-minute limits, retries on rate limits, and
keeps the previous day's take for any stock it skips. Without a key, cards show a rule-based "Auto summary" instead.

**Use Claude with your Pro/Max subscription (optional, replaces or backs up Groq).** On your computer, install
Claude Code and run `claude setup-token`, then add the printed token as the repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
The workflow's "Claude analyst takes" step reads `.ai/brief.md` (written by the data job), writes `.ai/claude_takes.json`,
and `scripts/merge-ai-takes.mjs` merges valid takes into `public/data/screener.json`. It uses your plan's usage; if it
fails or hits a limit, the Groq / earlier takes stay.

**Option B: keys in the browser.** Open the site → click the data chip → paste keys → Save. Calls go straight
from your browser to the APIs, are cached (5 min quotes / 24 h everything else), and the keys are stored only in
that browser. Good for testing; with 25 tickers it uses ~175 FMP calls on a cold load (free tier ≈ 250/day), so use a
shorter watchlist.

**Option C: Supabase (optional).** Create a free project, run `supabase/schema.sql` in the SQL editor, then add:
secrets `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the Action writes with this) and variables
`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (the site reads with this). Useful if you later want more than one
job writing data, or history.

> Never put the Supabase **service_role** key or private keys in `VITE_` variables: those are compiled into the
> public JavaScript on GitHub Pages.

## Files
| Path | What it does |
|---|---|
| `src/mockData.js` | Sample universe, analyst feed, insider trades, sample portfolio (illustrative values) |
| `src/config.js` | Settings: env defaults + Settings-drawer overrides |
| `src/api.js` | `fetchLatestScreenerData`, `fetchAnalystFeed`, `fetchInsiderActivity`, hooks, portfolio state |
| `src/lib/providers.js` | `fetch()` clients for FMP, Finnhub, Alpha Vantage, with caching |
| `src/lib/technicals.js` | Bullish FVG detection (daily + weekly), Fib depth, support, stop/targets/DCA zone |
| `src/lib/liveData.js` | Turns API responses into the app's stock / analyst / insider records |
| `src/lib/ai.js` | AI analyst take (Groq / Gemini, OpenAI-compatible) + rule-based fallback summary |
| `src/lib/schema.js` | Row mapping for Supabase and the JSON files |
| `src/scoring.js` | Composite score (Technical 35 / Valuation 35 / Street + Insiders 30) + rebalancing |
| `scripts/update-screener.mjs` | The background job (`npm run update-data` locally) |
| `supabase/schema.sql` | Tables + read-only public access |
| `.github/workflows/deploy.yml` | Scheduled refresh + build + deploy to Pages |

## Known limits on free plans
- Not every endpoint is free on every plan. When one is refused, that field shows "n/a" and scores 0, and the
  Settings drawer / Action log say which call failed.
- Analyst feed: Finnhub company news is filtered to analyst headlines (upgrades, downgrades, PT changes, initiations) and
  parsed for firm / action / old → new target, with the real article link. FMP grades fill in rating changes (no PTs on free data).
  Headline parsing is pattern-based, so an unusual headline can be missed or mis-read; the original headline is always shown.
- Finnhub insider transactions may require a paid plan; without them, the insider panel falls back to sample data.
- Catalysts in live mode are generated from the numbers (consensus, targets, DCF), not written analysis.
