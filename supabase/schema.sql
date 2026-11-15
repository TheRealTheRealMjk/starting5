-- Starting5: incolla tutto nel SQL Editor di Supabase ed esegui (una volta).

-- ---------- utenti ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_.-]{3,20}$')
);
create unique index profiles_username on public.profiles (lower(username));

-- Il profilo nasce con l'utente, prendendo lo username passato al signUp.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- dati LBA (scritti solo dalla Edge Function con la service key) ----------
create table public.teams (id int primary key, name text not null);
create table public.players (
  id int primary key, team_id int not null references public.teams, name text not null,
  role text, number text, active boolean not null default true);
create table public.matches (
  id int primary key, day int not null, starts_at timestamptz not null,
  home_id int, away_id int, status int);
create index matches_day on public.matches (day);
create table public.ratings (
  match_id int not null references public.matches, player_id int not null, val int not null,
  min int, -- minuti giocati: chi resta in panchina non abbassa la media
  primary key (match_id, player_id));

create table public.lineups (
  user_id uuid not null references auth.users on delete cascade,
  day int not null, player_id int not null references public.players,
  primary key (user_id, day, player_id));

-- ---------- permessi: tutto leggibile, formazioni solo le proprie, scritture solo via funzioni ----------
alter table public.profiles enable row level security;
alter table public.teams    enable row level security;
alter table public.players  enable row level security;
alter table public.matches  enable row level security;
alter table public.ratings  enable row level security;
alter table public.lineups  enable row level security;
create policy "read" on public.profiles for select using (true);
create policy "read" on public.teams    for select using (true);
create policy "read" on public.players  for select using (true);
create policy "read" on public.matches  for select using (true);
create policy "read" on public.ratings  for select using (true);
create policy "own"  on public.lineups  for select using (user_id = auth.uid());

create view public.days with (security_invoker = on) as
  select day, min(starts_at) starts_at from public.matches group by day;

create view public.player_stats with (security_invoker = on) as
  select player_id, count(*) filter (where min > 0) games,
    round(avg(val) filter (where min > 0), 1) avg_val
  from public.ratings group by player_id;
create view public.player_list with (security_invoker = on) as
  select p.id, p.name, p.role, p.number, t.name team, s.games, s.avg_val
  from public.players p join public.teams t on t.id = p.team_id
  left join public.player_stats s on s.player_id = p.id where p.active;
-- Migliori medie della stagione (almeno 3 partite giocate).
create view public.top_season with (security_invoker = on) as
  select p.name, t.name team, s.games, s.avg_val
  from public.player_stats s join public.players p on p.id = s.player_id join public.teams t on t.id = p.team_id
  where s.games >= 3 order by s.avg_val desc, p.name limit 5;
-- Migliori valutazioni dell'ultima giornata conclusa (ultima partita iniziata da almeno 2 ore).
create view public.top_last_day with (security_invoker = on) as
  with d as (select day from public.matches group by day
             having max(starts_at) <= now() - interval '2 hours' order by day desc limit 1)
  select d.day, p.name, t.name team, r.val
  from d join public.matches m on m.day = d.day join public.ratings r on r.match_id = m.id
  join public.players p on p.id = r.player_id join public.teams t on t.id = p.team_id
  order by r.val desc, p.name limit 5;


-- ---------- logica di gioco ----------
-- La giornata si blocca alla palla a due della sua prima partita.
create function public.save_lineup(p_day int, p_players int[]) returns void
language plpgsql security definer set search_path = '' as $$
declare start timestamptz;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  select min(starts_at) into start from public.matches where day = p_day;
  if start is null then raise exception 'Giornata inesistente'; end if;
  if now() >= start then raise exception 'Giornata già iniziata: formazione bloccata'; end if;
  if coalesce(cardinality(p_players), 0) <> 5 or (select count(distinct x) from unnest(p_players) x) <> 5 then
    raise exception 'Servono 5 giocatori diversi';
  end if;
  if (select count(*) from public.players where active and id = any (p_players)) <> 5 then
    raise exception 'Giocatore non valido';
  end if;
  delete from public.lineups where user_id = auth.uid() and day = p_day;
  insert into public.lineups (user_id, day, player_id) select auth.uid(), p_day, unnest(p_players);
end $$;

create function public.my_lineup(p_day int)
returns table (id int, name text, team text, points bigint)
language sql stable set search_path = '' as $$
  select p.id, p.name, t.name,
    (select sum(r.val) from public.ratings r join public.matches m on m.id = r.match_id
      where m.day = l.day and r.player_id = p.id)
  from public.lineups l join public.players p on p.id = l.player_id
  left join public.teams t on t.id = p.team_id
  where l.user_id = auth.uid() and l.day = p_day order by p.name
$$;

-- Classifica di una giornata, o generale se p_day è null. Espone solo username e punti.
create function public.standings(p_day int default null)
returns table (username text, points bigint)
language sql stable security definer set search_path = '' as $$
  select u.username, coalesce(sum(r.val), 0)
  from public.lineups l join public.profiles u on u.id = l.user_id
  left join public.matches m on m.day = l.day
  left join public.ratings r on r.match_id = m.id and r.player_id = l.player_id
  where p_day is null or l.day = p_day
  group by u.id, u.username order by 2 desc, 1
$$;

-- Partite da (ri)scaricare: iniziate nelle ultime 48h, o iniziate e ancora senza valutazioni.
create function public.matches_to_sync() returns setof int
language sql stable set search_path = '' as $$
  select id from public.matches m where starts_at <= now()
    and (starts_at > now() - interval '48 hours'
      or not exists (select 1 from public.ratings r where r.match_id = m.id))
$$;

revoke execute on function public.save_lineup, public.my_lineup, public.standings, public.matches_to_sync from public, anon, authenticated;
grant execute on function public.save_lineup, public.my_lineup to authenticated;
grant execute on function public.standings to anon, authenticated;
grant execute on function public.matches_to_sync to service_role;
