-- Migrazione 002: cancellazione account. Esegui una volta nel SQL Editor (i nuovi progetti l'hanno già in schema.sql).

-- Diritto alla cancellazione (GDPR art. 17): l'utente elimina il proprio account; profilo e formazioni vanno via in cascata.
create function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_account from public, anon, authenticated;
grant execute on function public.delete_account to authenticated;
