// Edge Function "sync": importa calendario, roster e valutazioni dall'API JSON di legabasket.it.
// Body {"full": true} = calendario + roster + valutazioni; altrimenti solo valutazioni.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

// sb_secret_ keys (injected as a JSON map); legacy service_role (retired in 2027) as fallback.
const KEY = Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'))[0] as string ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!KEY) throw new Error('Nessuna service/secret key disponibile');
const db = createClient(Deno.env.get('SUPABASE_URL')!, KEY);
const BASE = 'https://www.legabasket.it/api';

async function get(path: string) {
  const r = await fetch(BASE + path, { headers: { 'user-agent': 'starting5-fantasy' } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
function check<T>({ data, error }: { data: T; error: unknown }) {
  if (error) throw new Error(JSON.stringify(error));
  return data;
}

// only = refresh just these days (status and final scores of the games being played); default all.
async function syncCalendar(only?: number[]) {
  const { competitions } = await get('/championships/get-championships?current=1&items=1000');
  const rs = competitions.find((c: any) => c.ctype_code === 'RS');
  if (!rs) throw new Error('Regular season corrente non trovata');
  const cal = `/championships/get-championships-calendar-by-id?id=${rs.id}`;
  const { filters } = await get(cal);
  const matches = (await Promise.all(filters.days.filter((d: any) => !only || only.includes(d.event_serial))
    .map((d: any) => get(`${cal}&d=${d.event_serial}`))))
    .flatMap((r: any) => r.matches);
  const teams = new Map(matches.flatMap((m: any) => [[m.h_team_id, m.h_team_name], [m.v_team_id, m.v_team_name]]));
  check(await db.from('teams').upsert([...teams].map(([id, name]) => ({ id, name }))));
  check(await db.from('matches').upsert(matches.map((m: any) => ({
    id: m.id, day: m.day_serial, starts_at: m.match_datetime,
    home_id: m.h_team_id, away_id: m.v_team_id, status: Number(m.game_status),
    home_score: m.home_final_score ?? null, away_score: m.visitor_final_score ?? null,
  }))));
  return [...teams.keys()];
}

async function syncRosters(teamIds: number[]) {
  const rosters = await Promise.all(teamIds.map(async id => ({ id, ...(await get(`/teams/get-team-roster?id=${id}`)) })));
  // LBA gives '-' to new ids (e.g. a transfer): keep the role we already know for that id or name.
  const known = (check(await db.from('players').select('id, name, role').neq('role', '-')) as any[]) ?? [];
  const byId = new Map(known.map(p => [p.id, p.role])), byName = new Map(known.map(p => [p.name, p.role]));
  // After a transfer LBA may list a player in both rosters: keep the newest contract (a duplicate id fails the upsert).
  const latest = new Map<number, { p: any; team: number }>();
  for (const r of rosters as any[]) for (const p of r.players) {
    const old = latest.get(p.id);
    if (!old || (p.start_date ?? '') > (old.p.start_date ?? '')) latest.set(p.id, { p, team: r.id });
  }
  const players = [...latest.values()].map(({ p, team }) => {
    const name = `${p.name} ${p.surname}`, role = p.player_role && p.player_role !== '-' ? p.player_role : null;
    return { id: p.id, team_id: team, name, role: role ?? byId.get(p.id) ?? byName.get(name) ?? p.player_role ?? null,
      number: p.player_number ?? null, active: true };
  });
  if (!players.length) throw new Error('Roster vuoti');
  check(await db.from('players').upsert(players));
  // Upsert first, then deactivate the rest: a failure never empties the rosters.
  check(await db.from('players').update({ active: false }).not('id', 'in', `(${players.map(p => p.id).join(',')})`));
  return players.length;
}

async function syncScores() {
  const ids = (check(await db.rpc('matches_to_sync')) as any[]).map(x => typeof x === 'object' ? Object.values(x)[0] : x);
  const failed: string[] = [];
  for (const id of ids) {
    try { // one broken match (e.g. a permanent 404) must not stop the others
      const { scores } = await get(`/championships/get-championships-matches-scores-by-id?id=${id}`);
      const rows = [...(scores?.ht?.rows ?? []), ...(scores?.vt?.rows ?? [])].filter((r: any) => r.player_id);
      if (rows.length) check(await db.from('ratings').upsert(
        rows.map((r: any) => ({ match_id: id, player_id: r.player_id, val: Number(r.val_lega) || 0, min: Math.ceil((Number(r.sec) || 0) / 60) }))));
    } catch (e) { failed.push(`${id}: ${e}`); }
  }
  if (failed.length) throw new Error(`Partite non importate: ${failed.join('; ')}`); // still a 500 in the logs
  return ids.length;
}

// Days with a game started in the last 48h: the ones being played or just finished.
async function recentDays() {
  const now = Date.now(), rows = check(await db.from('matches').select('day')
    .gt('starts_at', new Date(now - 48 * 3600e3).toISOString()).lte('starts_at', new Date(now).toISOString())) as any[];
  return [...new Set(rows.map(r => r.day as number))];
}

const STYLE = `Sei un giornalista sportivo italiano che scrive di basket di Serie A (LBA).
Scrivi una breve notizia in italiano: 2-3 frasi, massimo 60 parole, tono vivace.
Usa SOLO i dati JSON forniti: non inventare statistiche, citazioni, infortuni o altri dettagli.
"val" è la valutazione Lega del giocatore. Niente titolo, niente markdown, niente emoji.`;
const FANTA = `Scrivi in italiano i complimenti al vincitore della giornata di Starting5, il fantabasket della Serie A:
2-3 frasi, massimo 60 parole, tono vivace. Chiama il vincitore esattamente {VINCITORE}.
Usa SOLO i dati JSON forniti: "punti" è la somma delle valutazioni Lega del suo quintetto. Niente titolo, niente markdown, niente emoji.`;

// Gemini writes from public LBA data only (no usernames: free-tier prompts may be used by Google); fixed text if it fails.
// On failure returns null so the next run retries; the fixed text only 36h after tip-off (games leave the sync after 48h).
// Free-tier models are often overloaded (503): then the lighter one gets a try.
async function write(facts: unknown, fallback: string, since: string, style = STYLE) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return fallback;
  for (const model of ['gemini-flash-latest', 'gemini-flash-lite-latest']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: style }] }, contents: [{ parts: [{ text: JSON.stringify(facts) }] }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const text = (await r.json()).candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('').trim();
      if (!text) throw new Error('risposta vuota');
      return text.slice(0, 600);
    } catch (e) { console.error(`Gemini ${model}:`, e); }
  }
  return Date.now() - Date.parse(since) > 36 * 3600e3 ? fallback : null;
}

// The day's Starting5 winner(s) right now: vincitore = usernames joined (ties), punti = their score.
async function winner(day: number) {
  const table = check(await db.rpc('standings', { p_day: day })) as any[];
  const punti = table[0]?.points ?? 0;
  const top = table.filter(r => r.points === punti);
  return { table, ties: top.length > 1, facts: { vincitore: top.map(r => r.username).join(' e '), punti } };
}

// Congratulations to the Starting5 winner of the day. Gemini writes {VINCITORE}, the username is put in here:
// usernames never go to Google. Ties get the fixed text naming every winner.
async function fanta(day: number, since: string, { table, ties, facts }: Awaited<ReturnType<typeof winner>>) {
  if (!facts.punti) return null;
  const [pick] = check(await db.rpc('most_picked', { p_day: day })) as any[];
  const fixed = `Fanta: {VINCITORE} vince la ${day}ª giornata con ${table[0].points} punti.` +
    (pick ? ` Il più schierato: ${pick.name}, in ${pick.picks} quintetti.` : '');
  const names = facts.vincitore;
  if (ties) return fixed.replace('vince', 'vincono a pari merito').replaceAll('{VINCITORE}', names);
  const team = check(await db.rpc('day_lineup', { p_day: day, p_username: names })) as any[];
  const text = await write({ giornata: day, punti: table[0].points, distacco_dal_secondo: table[1] ? table[0].points - table[1].points : null,
    partecipanti: table.length, quintetto: team.map(p => ({ nome: p.name, squadra: p.team, val: p.points ?? 0 })),
    giocatore_piu_schierato_da_tutti: pick ?? null }, fixed, since, FANTA);
  if (text === null) return null;
  return (text.includes('{VINCITORE}') ? text : fixed).replaceAll('{VINCITORE}', names);
}

// One news per finished game, then a day recap and the fanta result when the whole day is over;
// a correction news if LBA fixes its data later and the fanta winner or score changes.
async function syncNews() {
  const days = await recentDays();
  if (!days.length) return 0;
  const ms = check(await db.from('matches').select('id, day, starts_at, home_id, away_id, status, home_score, away_score').in('day', days)) as any[];
  const news = check(await db.from('news').select('day, key, facts').in('day', days).order('id')) as any[];
  const done = new Set(news.map(n => n.key));
  const teams = new Map((check(await db.from('teams').select('id, name')) as any[]).map(t => [t.id, t.name]));
  const ended = ms.filter(m => m.status === 2);
  const ratings = check(await db.from('ratings').select('match_id, player_id, val, min')
    .in('match_id', ended.map(m => m.id)).order('val', { ascending: false })) as any[];
  const players = new Map((check(await db.from('players').select('id, name, team_id')
    .in('id', [...new Set(ratings.map(r => r.player_id))])) as any[]).map(p => [p.id, p]));
  const best = (ids: number[], n: number) => ratings.filter(r => ids.includes(r.match_id)).slice(0, n)
    .map(r => ({ nome: players.get(r.player_id)?.name, squadra: teams.get(players.get(r.player_id)?.team_id), val: r.val }));
  const result = (m: any) => ({ casa: teams.get(m.home_id), ospite: teams.get(m.away_id), punti_casa: m.home_score, punti_ospite: m.away_score });
  // LBA sometimes marks a game over with a partial box score: a full one has 5 players x 40' (more with overtime).
  // After 36h we stop waiting (same rule as the fixed text) so a broken game never blocks the day.
  const full = (m: any) => ratings.filter(r => r.match_id === m.id).reduce((s, r) => s + r.min, 0) >= 400 ||
    Date.now() - Date.parse(m.starts_at) > 36 * 3600e3;
  const rows: { day: number; key: string; body: string | null; facts?: unknown }[] = [];
  const MAX = 3; // news per run (up to 2 Gemini calls each), so the function stays well inside its time limit; the rest goes in the next run

  for (const m of ended) {
    const top = best([m.id], 3), r = result(m);
    if (done.has(`match:${m.id}`) || !top.length || !full(m) || rows.length >= MAX) continue; // no full ratings yet: next run
    rows.push({ day: m.day, key: `match:${m.id}`, body: await write({ partita: r, migliori: top },
      `${r.casa} – ${r.ospite} ${r.punti_casa}-${r.punti_ospite}. Migliore in campo ${top[0].nome} con ${top[0].val} di valutazione.`, m.starts_at) });
  }
  for (const day of days) {
    const dm = ms.filter(m => m.day === day), last = dm.map(m => m.starts_at).sort().at(-1);
    // one hour after the last game's end (~2h), so LBA has time to fix its box scores
    if (dm.some(m => m.status !== 2 || !full(m)) || Date.now() - Date.parse(last) < 3 * 3600e3) continue;
    if (!done.has(`day:${day}`)) {
      if (rows.length >= MAX) continue;
      const ids = dm.map(m => m.id), res = dm.map(result), top = best(ids, 5);
      const margin = (r: any) => Math.abs(r.punti_casa - r.punti_ospite), total = (r: any) => r.punti_casa + r.punti_ospite;
      const mins = ratings.filter(r => ids.includes(r.match_id)).sort((a, b) => b.min - a.min)[0];
      const recap = await write({ giornata: day, risultati: res, migliori_valutazioni: top,
        vittoria_piu_larga: res.reduce((a, b) => margin(b) > margin(a) ? b : a),
        partita_con_piu_punti: res.reduce((a, b) => total(b) > total(a) ? b : a),
        vittorie_in_trasferta: res.filter(r => r.punti_ospite > r.punti_casa).length,
        piu_minuti_in_campo: mins && { nome: players.get(mins.player_id)?.name, minuti: mins.min } },
        `Si chiude la ${day}ª giornata.${top[0] ? ` MVP: ${top[0].nome} con ${top[0].val} di valutazione.` : ''}`, last);
      if (recap === null) continue; // fanta news waits for the recap, so it stays right after it
      rows.push({ day, key: `day:${day}`, body: recap });
    }
    if (rows.length >= MAX || !done.has(`day:${day}`) && !rows.some(r => r.key === `day:${day}`)) continue;
    const w = await winner(day);
    if (!done.has(`fanta:${day}`)) {
      const body = await fanta(day, last, w);
      if (body) rows.push({ day, key: `fanta:${day}`, body, facts: w.facts });
      continue;
    }
    // what the last fanta/correction news said (fanta news written before facts existed: nothing to compare)
    const said = news.filter(n => n.day === day && /^(fanta|fix):/.test(n.key)).at(-1)?.facts;
    if (!said || !w.facts.punti || (said.vincitore === w.facts.vincitore && said.punti === w.facts.punti)) continue;
    const fixes = news.filter(n => n.day === day && n.key.startsWith('fix:')).length;
    rows.push({ day, key: `fix:${day}:${fixes + 1}`, facts: w.facts, body: `Aggiornamento ${day}ª giornata: la Lega ha corretto i dati. ` +
      (said.vincitore === w.facts.vincitore
        ? `${w.facts.vincitore} ${w.ties ? "restano" : "resta"} in vetta con ${w.facts.punti} punti (prima ${said.punti}).`
        : `${w.facts.vincitore} ${w.ties ? 'vincono a pari merito' : 'vince'} con ${w.facts.punti} punti (prima ${said.vincitore} con ${said.punti}).`) });
  }
  const ready = rows.filter(r => r.body !== null);
  if (ready.length) check(await db.from('news').upsert(ready, { onConflict: 'key', ignoreDuplicates: true }));
  return ready.length;
}

Deno.serve(async req => {
  // shared secret instead of JWT, so pg_cron can call it whatever key format the project uses
  if (req.headers.get('x-sync-secret') !== Deno.env.get('SYNC_SECRET')) return new Response('forbidden', { status: 403 });
  const { full } = await req.json().catch(() => ({}));
  try {
    const out: Record<string, number> = {};
    if (full) {
      const teams = await syncCalendar();
      out.players = await syncRosters(teams);
    } else {
      const days = await recentDays(); // the 6-hourly full import is too slow to notice a game just ended
      if (days.length) await syncCalendar(days);
    }
    let failed;
    try { out.matches = await syncScores(); } catch (e) { failed = e; } // one broken game must not stop the news
    out.news = await syncNews();
    if (failed) throw failed;
    return Response.json(out);
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
