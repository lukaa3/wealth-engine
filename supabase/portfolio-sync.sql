-- Portfolio sync (phone ↔ Mac). Run once in the Supabase SQL editor.
-- The website only has the public anon key, so the table is fully closed to it;
-- these two functions are the only way in, and both require the portfolio's private sync code.
-- Only a SHA-256 hash of the code is stored.

create table if not exists public.portfolio_sync (
  code_hash  text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.portfolio_sync enable row level security;
revoke all on public.portfolio_sync from anon, authenticated;

create or replace function public.get_portfolio(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('data', data, 'updated_at', updated_at)
  from public.portfolio_sync
  where length(p_code) >= 16
    and code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

create or replace function public.save_portfolio(p_code text, p_data jsonb, p_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(p_code) < 16 then raise exception 'sync code too short'; end if;
  if pg_column_size(p_data) > 200000 then raise exception 'portfolio too large'; end if;
  insert into public.portfolio_sync as t (code_hash, data, updated_at)
  values (encode(sha256(convert_to(p_code, 'UTF8')), 'hex'), p_data, coalesce(p_updated_at, now()))
  on conflict (code_hash) do update
    set data = excluded.data, updated_at = excluded.updated_at
    where t.updated_at <= excluded.updated_at;   -- last edit wins; older saves never overwrite newer ones
  return public.get_portfolio(p_code);
end;
$$;

revoke all on function public.get_portfolio(text) from public;
revoke all on function public.save_portfolio(text, jsonb, timestamptz) from public;
grant execute on function public.get_portfolio(text) to anon, authenticated;
grant execute on function public.save_portfolio(text, jsonb, timestamptz) to anon, authenticated;
