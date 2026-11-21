-- Starting5: incolla tutto nel SQL Editor di Supabase ed esegui (una volta).

-- ---------- utenti ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_.-]{3,20}$')
);
create unique index profiles_username on public.profiles (lower(username));

-- Il profilo nasce con l'utente: handle_new_user è definita più sotto, con le leghe.

-- ---------- dati LBA (scritti solo dalla Edge Function con la service key) ----------
create table public.teams (id int primary key, name text not null);
create table public.players (
  id int primary key, team_id int not null references public.teams, name text not null,
  role text, number text, active boolean not null default true);
create table public.matches (
  id int primary key, day int not null, starts_at timestamptz not null,
  home_id int, away_id int, status int, -- status 2 = finita
  home_score int, away_score int);
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

-- Una giornata è finita 2 ore dopo la palla a due della sua ultima partita (come top_last_day).
create view public.days with (security_invoker = on) as
  select day, min(starts_at) starts_at, max(starts_at) + interval '2 hours' ends_at from public.matches group by day;

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
-- Record vinte-perse di ogni squadra, dalle partite finite.
create view public.team_records with (security_invoker = on) as
  select team_id, count(*) filter (where won) wins, count(*) filter (where not won) losses
  from (select home_id team_id, home_score > away_score won from public.matches where status = 2
        union all
        select away_id, away_score > home_score from public.matches where status = 2) g
  group by team_id;
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
  -- shortcut: a postponed match keeps its day "in corso" until played; fix its starts_at by hand if that blocks a day
  if exists (select 1 from public.matches group by day having day < p_day and max(starts_at) + interval '2 hours' > now()) then
    raise exception 'Puoi schierare solo la prossima giornata, quando la precedente è finita';
  end if;
  if coalesce(cardinality(p_players), 0) <> 5 or (select count(distinct x) from unnest(p_players) x) <> 5 then
    raise exception 'Servono 5 giocatori diversi';
  end if;
  if (select count(*) from public.players where active and id = any (p_players)) <> 5 then
    raise exception 'Giocatore non valido';
  end if;
  -- almeno 2 piccoli e 2 lunghi; chi ha ruolo '-' non è selezionabile (si corregge a mano in players.role)
  if (select count(*) filter (where role ~ 'Play|Guardia') < 2
          or count(*) filter (where role !~ 'Play|Guardia' and role ~ 'Ala|Centro') < 2
          or count(*) filter (where role ~ 'Play|Guardia|Ala|Centro') <> 5
      from public.players where id = any (p_players)) then
    raise exception 'Servono almeno 2 piccoli e 2 lunghi';
  end if;
  -- budget: ogni giocatore costa la sua media (negativa o senza partite = 0)
  if (select sum(greatest(coalesce(s.avg_val, 0), 0)) from public.player_stats s where s.player_id = any (p_players)) > 80 then
    raise exception 'Budget superato: hai 80 Ðan';
  end if;
  -- one save per user at a time: two parallel saves would both delete nothing and leave 10 players
  perform 1 from public.profiles where id = auth.uid() for update;
  delete from public.lineups where user_id = auth.uid() and day = p_day;
  insert into public.lineups (user_id, day, player_id) select auth.uid(), p_day, unnest(p_players);
end $$;

-- La formazione vale anche per le giornate successive finché non ne salvi una nuova: per la giornata N conta l'ultima salvata
-- per una giornata <= N, così come è (anche se ai prezzi di oggi sforerebbe il budget). from_day = giornata in cui è stata salvata.
create function public.my_lineup(p_day int)
returns table (id int, name text, team text, points bigint, from_day int)
language sql stable set search_path = '' as $$
  select p.id, p.name, t.name,
    (select sum(r.val) from public.ratings r join public.matches m on m.id = r.match_id
      where m.day = p_day and r.player_id = p.id),
    l.day
  from public.lineups l join public.players p on p.id = l.player_id
  left join public.teams t on t.id = p.team_id
  where l.user_id = auth.uid()
    and l.day = (select max(x.day) from public.lineups x where x.user_id = auth.uid() and x.day <= p_day)
  order by p.name
$$;

-- Storico per il profilo: le giornate già iniziate, con la formazione in vigore e i punti di ogni giocatore.
create function public.my_history()
returns table (day int, id int, name text, team text, points bigint, from_day int)
language sql stable set search_path = '' as $$
  select d.day, l.id, l.name, l.team, l.points, l.from_day
  from public.days d cross join lateral public.my_lineup(d.day) l
  where d.starts_at <= now() order by d.day desc, l.name
$$;

-- Il nome della squadra (username) si cambia dal profilo, con le stesse regole della registrazione.
-- Quintetto di un altro giocatore in una giornata: visibile a tutti solo da quando la giornata è iniziata.
create function public.day_lineup(p_day int, p_username text)
returns table (name text, team text, points bigint)
language sql stable security definer set search_path = '' as $$
  select p.name, t.name,
    (select sum(r.val) from public.ratings r join public.matches m on m.id = r.match_id
      where m.day = p_day and r.player_id = p.id)
  from public.profiles u
  join public.lineups l on l.user_id = u.id
    and l.day = (select max(x.day) from public.lineups x where x.user_id = u.id and x.day <= p_day)
  join public.players p on p.id = l.player_id
  left join public.teams t on t.id = p.team_id
  where u.username = p_username
    and (select min(starts_at) from public.matches where day = p_day) <= now()
  order by 3 desc nulls last, 1
$$;
create function public.rename_user(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  if coalesce(btrim(p_username), '') !~ '^[A-Za-z0-9_.-]{3,20}$' then
    raise exception 'Nome squadra: 3-20 caratteri tra lettere, numeri, _ . -';
  end if;
  update public.profiles set username = btrim(p_username) where id = auth.uid();
exception when unique_violation then raise exception 'Nome già usato da un altro giocatore';
end $$;

-- Partite da (ri)scaricare: iniziate nelle ultime 48h, o iniziate e ancora senza valutazioni.
create function public.matches_to_sync() returns setof int
language sql stable set search_path = '' as $$
  select id from public.matches m where starts_at <= now()
    and (starts_at > now() - interval '48 hours'
      or not exists (select 1 from public.ratings r where r.match_id = m.id))
$$;

revoke execute on function public.save_lineup, public.my_lineup, public.my_history, public.rename_user, public.matches_to_sync from public, anon, authenticated;
grant execute on function public.save_lineup, public.my_lineup, public.my_history, public.rename_user to authenticated;
grant execute on function public.matches_to_sync to service_role;

-- Diritto alla cancellazione (GDPR art. 17): l'utente elimina il proprio account; profilo e formazioni vanno via in cascata.
create function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_account from public, anon, authenticated;
grant execute on function public.delete_account to authenticated;

-- ---------- leghe private ----------
-- Una lega è solo una classifica filtrata: la formazione di giornata resta una sola e vale ovunque.
create table public.leagues (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 3 and 40),
  code text not null unique,
  -- shortcut: if the owner deletes their account the league goes with it; add ownership transfer if users ask for it
  owner_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now());
create table public.league_members (
  league_id bigint not null references public.leagues on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id));
create index league_members_user on public.league_members (user_id);

-- security definer so the policies below can check membership without recursing into themselves
create function public.is_member(p_league bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_members where league_id = p_league and user_id = auth.uid())
$$;

alter table public.leagues        enable row level security;
alter table public.league_members enable row level security;
create policy "members" on public.leagues        for select using (public.is_member(id));
create policy "members" on public.league_members for select using (public.is_member(league_id));

-- Entra in una lega dato il codice (idempotente). Usata dal sito e dal trigger di registrazione.
create function public.add_member(p_user uuid, p_code text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare lid bigint;
begin
  select id into lid from public.leagues where code = upper(btrim(p_code));
  if lid is null then raise exception 'Codice lega non valido'; end if;
  if not exists (select 1 from public.league_members where league_id = lid and user_id = p_user)
     and (select count(*) from public.league_members where user_id = p_user) >= 20 then
    raise exception 'Puoi far parte al massimo di 20 leghe';
  end if;
  insert into public.league_members (league_id, user_id) values (lid, p_user) on conflict do nothing;
  return lid;
end $$;

create function public.join_league(p_code text) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  return public.add_member(auth.uid(), p_code);
end $$;

create function public.create_league(p_name text) returns table (id bigint, code text)
language plpgsql security definer set search_path = '' as $$
declare c text; lid bigint;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 3 and 40 then raise exception 'Nome lega: da 3 a 40 caratteri'; end if;
  if (select count(*) from public.leagues l where l.owner_id = auth.uid()) >= 10 then
    raise exception 'Puoi creare al massimo 10 leghe';
  end if;
  loop -- 6 characters without look-alikes (0/O, 1/I/L): ~900M codes, collisions just retry
    c := (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from public.leagues l where l.code = c);
  end loop;
  insert into public.leagues (name, code, owner_id) values (btrim(p_name), c, auth.uid()) returning leagues.id into lid;
  insert into public.league_members (league_id, user_id) values (lid, auth.uid());
  return query select lid, c;
end $$;

-- Le mie leghe, con numero di membri.
create function public.my_leagues()
returns table (id bigint, name text, code text, is_owner boolean, members bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, l.name, l.code, l.owner_id = auth.uid(),
    (select count(*) from public.league_members x where x.league_id = l.id)
  from public.leagues l join public.league_members m on m.league_id = l.id and m.user_id = auth.uid()
  order by l.name
$$;

-- Membri di una lega (solo per chi ne fa parte).
create function public.league_roster(p_league bigint)
returns table (user_id uuid, username text, is_owner boolean)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.username, m.user_id = l.owner_id
  from public.league_members m join public.leagues l on l.id = m.league_id
  join public.profiles u on u.id = m.user_id
  where m.league_id = p_league and public.is_member(p_league)
  order by m.user_id <> l.owner_id, lower(u.username)
$$;

create function public.leave_league(p_league bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.leagues where id = p_league and owner_id = auth.uid()) then
    raise exception 'Hai creato tu questa lega: puoi eliminarla, non uscirne';
  end if;
  delete from public.league_members where league_id = p_league and user_id = auth.uid();
end $$;

-- Azioni riservate a chi ha creato la lega.
create function public.owned(p_league bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.leagues where id = p_league and owner_id = auth.uid()) then
    raise exception 'Solo chi ha creato la lega può farlo';
  end if;
end $$;

create function public.rename_league(p_league bigint, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.owned(p_league);
  if char_length(btrim(coalesce(p_name, ''))) not between 3 and 40 then raise exception 'Nome lega: da 3 a 40 caratteri'; end if;
  update public.leagues set name = btrim(p_name) where id = p_league;
end $$;

create function public.remove_member(p_league bigint, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.owned(p_league);
  if p_user = auth.uid() then raise exception 'Non puoi rimuovere te stesso'; end if;
  delete from public.league_members where league_id = p_league and user_id = p_user;
end $$;

create function public.delete_league(p_league bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.owned(p_league);
  delete from public.leagues where id = p_league;
end $$;

-- Classifica di una giornata (o generale se p_day è null), di tutti o di una lega.
-- In una lega compaiono tutti i membri, anche chi non ha ancora schierato nessuno (0 punti).
create function public.standings(p_day int default null, p_league bigint default null)
returns table (username text, points bigint)
language sql stable security definer set search_path = '' as $$
  with src as ( -- for every user and day, the lineup in force: the last one saved for that day or an earlier one
    select u.user_id, d.day, (select max(x.day) from public.lineups x where x.user_id = u.user_id and x.day <= d.day) src
    from (select distinct user_id from public.lineups) u
    cross join (select distinct day from public.matches where p_day is null or day = p_day) d),
  pts as (
    select s.user_id, coalesce(sum(r.val), 0)::bigint points
    from src s
    join public.lineups l on l.user_id = s.user_id and l.day = s.src
    left join public.matches m on m.day = s.day
    left join public.ratings r on r.match_id = m.id and r.player_id = l.player_id
    group by s.user_id),
  who as (
    select user_id from pts where p_league is null
    union
    select user_id from public.league_members where league_id = p_league and public.is_member(p_league))
  select u.username, coalesce(p.points, 0)::bigint
  from who join public.profiles u on u.id = who.user_id left join pts p on p.user_id = who.user_id
  order by 2 desc, 1
$$;

-- Chi si registra da un link di invito entra subito nella lega (il codice viaggia nei metadati del signUp,
-- così funziona anche se la mail di conferma si apre su un altro dispositivo).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  if new.raw_user_meta_data ->> 'league' is not null then
    begin
      perform public.add_member(new.id, new.raw_user_meta_data ->> 'league');
    exception when others then null; -- an invalid or expired code must never block the sign-up
    end;
  end if;
  return new;
end $$;

revoke execute on function public.add_member, public.owned, public.join_league, public.create_league,
  public.my_leagues, public.league_roster, public.leave_league, public.rename_league, public.remove_member,
  public.delete_league, public.standings from public, anon, authenticated;
grant execute on function public.join_league, public.create_league, public.my_leagues, public.league_roster,
  public.leave_league, public.rename_league, public.remove_member, public.delete_league to authenticated;
grant execute on function public.standings, public.day_lineup to anon, authenticated;
grant execute on function public.is_member to anon, authenticated; -- needed by the RLS policies; reveals only your own membership
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
