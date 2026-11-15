-- Migrazione 003: leghe private. Esegui una volta nel SQL Editor (i nuovi progetti l'hanno già in schema.sql).
drop function public.standings(int); -- replaced by standings(int, bigint)

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
  with pts as (
    select l.user_id, coalesce(sum(r.val), 0)::bigint points
    from public.lineups l
    left join public.matches m on m.day = l.day
    left join public.ratings r on r.match_id = m.id and r.player_id = l.player_id
    where p_day is null or l.day = p_day
    group by l.user_id),
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
create or replace function public.handle_new_user() returns trigger
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
grant execute on function public.standings to anon, authenticated;
grant execute on function public.is_member to anon, authenticated; -- needed by the RLS policies; reveals only your own membership
