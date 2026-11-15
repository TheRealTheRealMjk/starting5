// Edge Function "sync": importa calendario, roster e valutazioni dall'API JSON di legabasket.it.
// Body {"full": true} = calendario + roster + valutazioni; altrimenti solo valutazioni.
import { createClient } from 'npm:@supabase/supabase-js@2';

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

async function syncCalendar() {
  const { competitions } = await get('/championships/get-championships?current=1&items=1000');
  const rs = competitions.find((c: any) => c.ctype_code === 'RS');
  if (!rs) throw new Error('Regular season corrente non trovata');
  const cal = `/championships/get-championships-calendar-by-id?id=${rs.id}`;
  const { filters } = await get(cal);
  const matches = (await Promise.all(filters.days.map((d: any) => get(`${cal}&d=${d.event_serial}`))))
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
  const players = rosters.flatMap((r: any) => r.players.map((p: any) => ({
    id: p.id, team_id: r.id, name: `${p.name} ${p.surname}`,
    role: p.player_role ?? null, number: p.player_number ?? null, active: true,
  })));
  if (!players.length) throw new Error('Roster vuoti');
  check(await db.from('players').upsert(players));
  // Upsert first, then deactivate the rest: a failure never empties the rosters.
  check(await db.from('players').update({ active: false }).not('id', 'in', `(${players.map(p => p.id).join(',')})`));
  return players.length;
}

async function syncScores() {
  const ids = (check(await db.rpc('matches_to_sync')) as any[]).map(x => typeof x === 'object' ? Object.values(x)[0] : x);
  for (const id of ids) {
    const { scores } = await get(`/championships/get-championships-matches-scores-by-id?id=${id}`);
    const rows = [...(scores?.ht?.rows ?? []), ...(scores?.vt?.rows ?? [])].filter((r: any) => r.player_id);
    if (rows.length) check(await db.from('ratings').upsert(
      rows.map((r: any) => ({ match_id: id, player_id: r.player_id, val: Number(r.val_lega) || 0, min: Math.ceil((Number(r.sec) || 0) / 60) }))));
  }
  return ids.length;
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
    }
    out.matches = await syncScores();
    return Response.json(out);
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
