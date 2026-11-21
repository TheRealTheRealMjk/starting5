-- Aggiornamento del 21/11/2026: quintetti degli altri giocatori visibili da quando la giornata è iniziata. Esegui questo file nel SQL Editor.
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
revoke execute on function public.day_lineup from public;
grant execute on function public.day_lineup to anon, authenticated;
