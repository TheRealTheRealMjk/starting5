-- Aggiornamento del 21/11/2026: la formazione della giornata successiva si apre solo quando la precedente è finita. Esegui questo file nel SQL Editor.
-- Una giornata è finita 2 ore dopo la palla a due della sua ultima partita (come top_last_day).
create or replace view public.days with (security_invoker = on) as
  select day, min(starts_at) starts_at, max(starts_at) + interval '2 hours' ends_at from public.matches group by day;

create or replace function public.save_lineup(p_day int, p_players int[]) returns void
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
