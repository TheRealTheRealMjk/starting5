# Starting5 — Fantabasket LBA

Ogni giornata scegli 5 giocatori della Serie A; il tuo punteggio è la somma della loro valutazione Lega ufficiale.
Classifica per giornata e generale. La formazione si blocca alla palla a due della prima partita della giornata.

- `docs/` — il sito (pagina statica, pubblicata con GitHub Pages)
- `supabase/schema.sql` — tabelle, permessi e logica di gioco
- `supabase/functions/sync/` — import da legabasket.it (Edge Function)
- `supabase/cron.sql` — import automatico ogni 10 minuti (valutazioni) e ogni 6 ore (calendario e roster)

## Messa online (una volta sola, tutto dal browser)

### 1. Supabase
1. Crea un progetto su supabase.com.
2. **SQL Editor** → incolla `supabase/schema.sql` → *Run*.
3. **Edge Functions** → *Deploy a new function* → *Via Editor*, nome `sync`, incolla `supabase/functions/sync/index.ts` → *Deploy*.
   Poi nelle impostazioni della funzione disattiva **Verify JWT** (la protegge il secret del punto seguente).
4. **Edge Functions → Secrets** → aggiungi `SYNC_SECRET` con una stringa lunga e casuale (es. da un password generator).
5. **SQL Editor** → incolla `supabase/cron.sql`, sostituisci `SYNC_SECRET` (e l'URL del progetto, se diverso) → *Run*.
   Pianifica l'import e ne lancia subito uno completo. Dopo un minuto in **Table Editor** le tabelle `matches`, `players`, `ratings` devono essere piene.
   Gli errori si vedono in **Edge Functions → sync → Logs**.

### 2. GitHub
1. Crea un repository **pubblico** (GitHub Pages gratis richiede repo pubblico) e carica questi file.
2. In `docs/config.js` metti URL del progetto e chiave *anon* / *publishable* (Supabase → **Project Settings → API**).
   È pubblica per design: i permessi li fa il database. **Mai** la service_role / secret key.
3. Repository → **Settings → Pages** → *Deploy from a branch* → branch `main`, cartella `/docs`.
   Il sito sarà su `https://TUO-UTENTE.github.io/NOME-REPO/`.

### 3. Collega i due
Supabase → **Authentication → URL Configuration** → *Site URL* = l'indirizzo GitHub Pages
(serve per il link nella mail di conferma registrazione).

## Test

```bash
npm i @electric-sql/pglite
node supabase/test.mjs
```
Esegue `schema.sql` su un Postgres in memoria e verifica blocco giornata, validazione formazione e classifiche.

## Limiti del piano free
- Supabase mette in pausa il progetto dopo 7 giorni senza attività: va riattivato dalla dashboard.
- Le mail di conferma del servizio integrato sono limitate a poche all'ora: con molte registrazioni
  serve un SMTP proprio (Authentication → SMTP) o disattivare la conferma email.
