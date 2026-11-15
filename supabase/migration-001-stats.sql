-- Aggiornamento del 15/11/2026 per un database creato con lo schema precedente.
alter table public.ratings add column min int;
drop view public.player_list;
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
-- DOPO aver ripubblicato la funzione sync (che salva i minuti), esegui a parte:
--   delete from public.ratings;
-- così il cron riscarica tutti i tabellini al giro successivo.
