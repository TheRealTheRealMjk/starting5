-- Aggiornamento del 15/11/2026: punteggi delle partite e record delle squadre.
-- 1) Esegui questo file nel SQL Editor. 2) Ripubblica la funzione sync. 3) Lancia una sync completa
--    (o aspetta il cron lba-full, ogni 6 ore) per scaricare i punteggi delle partite già giocate.
alter table public.matches add column home_score int, add column away_score int;
-- Record vinte-perse di ogni squadra, dalle partite finite.
create view public.team_records with (security_invoker = on) as
  select team_id, count(*) filter (where won) wins, count(*) filter (where not won) losses
  from (select home_id team_id, home_score > away_score won from public.matches where status = 2
        union all
        select away_id, away_score > home_score from public.matches where status = 2) g
  group by team_id;
