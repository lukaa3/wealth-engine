-- Wealth & Stock Intelligence Engine — Supabase schema.
-- Run in the Supabase SQL editor. The GitHub Action writes with the service_role key;
-- the website reads with the public anon key, which these policies limit to SELECT.

create table if not exists public.screener_metrics (
  ticker              text primary key,
  name                text,
  sector              text,
  price               numeric,
  beta                numeric,
  dcf_value           numeric,
  peg_ratio           numeric,
  forward_pe          numeric,
  fvg_timeframe       text,          -- 'Weekly' | 'Daily' | null
  fvg_status          text,          -- 'Rejected' | 'Testing' | 'None'
  fvg_low             numeric,
  fvg_high            numeric,
  fib_level           numeric,       -- 0.5 | 0.618 | 0.705 | 0.786 | null
  structural_support  boolean default false,
  stop_price          numeric,
  target_1m           numeric,
  target_6m           numeric,
  target_12m          numeric,       -- Street consensus price target
  buy_pct             numeric,       -- share of analysts at Buy/Strong Buy (0-1)
  analyst_count       integer,
  buy_zone_low        numeric,
  buy_zone_high       numeric,
  catalysts           jsonb default '[]'::jsonb,
  invalidation_triggers jsonb default '[]'::jsonb,
  composite_score     numeric,
  technical_score     numeric,
  fundamental_score   numeric,
  sentiment_score     numeric,
  ai_take             jsonb,         -- { verdict, summary, bull[], bear[], watch, confidence, model, generatedAt }
  updated_at          timestamptz default now()
);
alter table public.screener_metrics add column if not exists ai_take jsonb;
alter table public.screener_metrics add column if not exists dcf_nm boolean default false; -- negative free cash flow
alter table public.screener_metrics add column if not exists stale_fields jsonb; -- { field: "YYYY-MM-DD" } values carried from an earlier run

create table if not exists public.analyst_actions (
  id           bigint generated always as identity primary key,
  action_date  date not null,
  ticker       text not null,
  firm         text not null,
  action       text,                 -- Upgrade | Downgrade | PT Raise | PT Cut | Initiate | Reiterate
  from_rating  text,
  to_rating    text not null default '',
  old_target   numeric,
  new_target   numeric,
  rationale    text,
  source_name  text,
  source_url   text,
  headline     text,
  unique (ticker, firm, action_date, to_rating)
);
alter table public.analyst_actions add column if not exists headline text;

create table if not exists public.insider_transactions (
  id            bigint generated always as identity primary key,
  filing_date   date not null,
  ticker        text not null,
  insider_role  text not null default '',
  shares        numeric,
  value         numeric not null,    -- USD, positive = buy, negative = sale
  is_10b5_1     boolean default false,
  filing_url    text,
  unique (ticker, filing_date, insider_role, value)
);

alter table public.screener_metrics     enable row level security;
alter table public.analyst_actions      enable row level security;
alter table public.insider_transactions enable row level security;

drop policy if exists "public read" on public.screener_metrics;
drop policy if exists "public read" on public.analyst_actions;
drop policy if exists "public read" on public.insider_transactions;
create policy "public read" on public.screener_metrics     for select to anon using (true);
create policy "public read" on public.analyst_actions      for select to anon using (true);
create policy "public read" on public.insider_transactions for select to anon using (true);
-- No insert/update/delete policies for anon: only the service_role key (used by the Action) can write.
