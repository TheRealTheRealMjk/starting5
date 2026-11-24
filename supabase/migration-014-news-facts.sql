-- Aggiornamento del 24/11/2026: rettifiche delle news fanta se la Lega corregge i dati dopo. Esegui questo file nel SQL Editor.
-- facts = vincitore e punti scritti nella news fanta/rettifica ('fix:<giornata>:<n>'), per accorgersi se poi cambiano.
alter table public.news add column facts jsonb;
