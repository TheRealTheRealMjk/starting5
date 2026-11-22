-- Aggiornamento del 22/11/2026: news della giornata in home, scritte dalla Edge Function sync. Esegui questo file nel SQL Editor.
-- News: una riga per evento (key = 'match:<id>', 'day:<n>', 'fanta:<n>'), così il sync non la riscrive due volte.
create table public.news (
  id bigint generated always as identity primary key,
  day int not null, key text not null unique, body text not null,
  created_at timestamptz not null default now());
alter table public.news enable row level security;
create policy "read" on public.news for select using (true);

-- Il giocatore presente in più quintetti in vigore nella giornata (per la news fanta di fine giornata).
create function public.most_picked(p_day int) returns table (name text, picks bigint)
language sql stable security definer set search_path = '' as $$
  select p.name, count(*) from (select distinct user_id from public.lineups) u
  join public.lineups l on l.user_id = u.user_id
    and l.day = (select max(x.day) from public.lineups x where x.user_id = u.user_id and x.day <= p_day)
  join public.players p on p.id = l.player_id
  group by p.name order by 2 desc, 1 limit 1
$$;
revoke execute on function public.most_picked from public, anon, authenticated;
grant execute on function public.most_picked, public.standings to service_role;
