-- Aggiornamento del 19/11/2026: schermata Profilo (storico giornate, nome squadra modificabile). Esegui questo file nel SQL Editor.
-- Storico per il profilo: le giornate già iniziate, con la formazione in vigore e i punti di ogni giocatore.
create function public.my_history()
returns table (day int, id int, name text, team text, points bigint, from_day int)
language sql stable set search_path = '' as $$
  select d.day, l.id, l.name, l.team, l.points, l.from_day
  from public.days d cross join lateral public.my_lineup(d.day) l
  where d.starts_at <= now() order by d.day desc, l.name
$$;

-- Il nome della squadra (username) si cambia dal profilo, con le stesse regole della registrazione.
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
revoke execute on function public.my_history, public.rename_user from public, anon, authenticated;
grant execute on function public.my_history, public.rename_user to authenticated;
