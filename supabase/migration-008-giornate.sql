-- Aggiornamento del 18/11/2026: chi non salva la formazione tiene quella della giornata prima; si schiera solo la prossima giornata.
-- Esegui questo file nel SQL Editor.
create or replace function public.save_lineup(p_day int, p_players int[]) returns void
language plpgsql security definer set search_path = '' as $$
declare start timestamptz;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  select min(starts_at) into start from public.matches where day = p_day;
  if start is null then raise exception 'Giornata inesistente'; end if;
  if now() >= start then raise exception 'Giornata già iniziata: formazione bloccata'; end if;
  if exists (select 1 from public.matches group by day having day < p_day and min(starts_at) > now()) then
    raise exception 'Puoi schierare solo la prossima giornata';
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
  delete from public.lineups where user_id = auth.uid() and day = p_day;
  insert into public.lineups (user_id, day, player_id) select auth.uid(), p_day, unnest(p_players);
end $$;

drop function public.my_lineup(int); -- cambia il tipo restituito (from_day)
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
revoke execute on function public.my_lineup from public, anon, authenticated;
grant execute on function public.my_lineup to authenticated;

create or replace function public.standings(p_day int default null, p_league bigint default null)
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
