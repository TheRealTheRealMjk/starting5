-- Pianifica l'import e lancia subito il primo import completo.
-- Sostituisci SOLO il segnaposto SYNC_SECRET (riga "secret") con il valore messo nei secrets della Edge Function.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  secret text := 'SYNC_SECRET';
  fn_url text := 'https://divlxkvwxwxvotoqyfvd.supabase.co/functions/v1/sync';
  hdrs text := json_build_object('content-type', 'application/json', 'x-sync-secret', secret)::text;
  tpl text := 'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 120000)';
begin
  if secret = 'SYNC' || '_SECRET' then raise exception 'Sostituisci SYNC_SECRET con il tuo secret'; end if;
  perform cron.schedule('lba-scores', '*/10 * * * *', format(tpl, fn_url, hdrs, '{"full": false}'));
  perform cron.schedule('lba-full', '7 */6 * * *', format(tpl, fn_url, hdrs, '{"full": true}'));
  perform net.http_post(url := fn_url, headers := hdrs::jsonb, body := '{"full": true}'::jsonb, timeout_milliseconds := 120000);
end $$;
