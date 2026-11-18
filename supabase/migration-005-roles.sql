-- Aggiornamento del 18/11/2026: formazione con 3 piccoli e 2 lunghi. Esegui questo file nel SQL Editor.
create or replace function public.save_lineup(p_day int, p_players int[]) returns void
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
  -- 3 piccoli + 2 lunghi; chi ha ruolo '-' non è selezionabile (si corregge a mano in players.role)
  if (select count(*) filter (where role ~ 'Play|Guardia') <> 3
          or count(*) filter (where role !~ 'Play|Guardia' and role ~ 'Ala|Centro') <> 2
      from public.players where id = any (p_players)) then
    raise exception 'Servono 3 piccoli e 2 lunghi';
  end if;
  delete from public.lineups where user_id = auth.uid() and day = p_day;
  insert into public.lineups (user_id, day, player_id) select auth.uid(), p_day, unnest(p_players);
end $$;
-- Ruoli assegnati a mano (LBA li dà come '-'); la sync non li sovrascrive.
update public.players set role = 'Guardia' where id in (9455, 9456) and role = '-'; -- Erick Green (Cantù), Christian Vital
