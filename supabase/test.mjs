// Self-check of schema.sql on an in-memory Postgres with a minimal stub of Supabase's auth schema.
// Run: npm i @electric-sql/pglite && node supabase/test.mjs
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert';
import fs from 'node:fs';

const pg = new PGlite();
await pg.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
`);
await pg.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
await pg.exec(`
  insert into auth.users values ('${A}', '{"username":"anna"}'), ('${B}', '{"username":"bob"}');
  insert into teams values (1,'A'),(2,'B');
  insert into matches values (10,1,now()-interval '2 days',1,2,2),(11,1,now()-interval '1 day',1,2,2),(20,2,now()+interval '3 days',1,2,0);
  insert into players (id, team_id, name, role) select i, i % 2 + 1, 'P' || i, case when i <= 4 then 'Guardia' when i <= 7 then 'Centro' else '-' end from generate_series(1, 7) i;
  insert into players values (8, 1, 'P8', 'Ala/Centro', null, true), (9, 2, 'P9', '-', null, true);
  -- day 1 is already locked, so seed it directly
  insert into lineups select '${A}', 1, unnest(array[1,2,3,4,5]);
  insert into lineups select '${B}', 1, unnest(array[3,4,5,6,7]);
  insert into ratings values (10,1,20,30),(10,3,-2,10),(10,4,0,0),(11,6,15,25),(20,2,99,40);
`);
const as = async (uid, sql, params) => { await pg.query(`select set_config('test.uid', $1, false)`, [uid]); return (await pg.query(sql, params)).rows; };
const rejects = (p, re) => assert.rejects(p, re);

await rejects(as(A, 'select save_lineup(1, array[1,2,3,4,5])'), /bloccata/);
await rejects(as(A, 'select save_lineup(2, array[1,1,2,3,4])'), /5 giocatori/);
await rejects(as(A, 'select save_lineup(2, array[1,2,3,4,99])'), /non valido/);
await rejects(as(A, 'select save_lineup(9, array[1,2,3,4,5])'), /inesistente/);
await rejects(as(A, 'select save_lineup(2, array[1,2,3,4,5])'), /almeno 2/); // 4 guards
await rejects(as(A, 'select save_lineup(2, array[1,5,6,7,8])'), /almeno 2/); // 4 bigs
await as(A, 'select save_lineup(2, array[1,2,6,7,8])'); // 2+3 is fine
await rejects(as(A, 'select save_lineup(2, array[1,2,3,8,9])'), /almeno 2/); // unknown role
await as(A, 'select save_lineup(2, array[1,2,3,7,8])');
await rejects(as('', 'select save_lineup(2, array[1,2,3,4,5])'), /Accesso/);
await rejects(pg.exec(`insert into auth.users values (gen_random_uuid(), '{"username":"ANNA"}')`), /duplicate/);

assert.deepEqual(await as(A, 'select * from standings(1)'), [{ username: 'anna', points: 18 }, { username: 'bob', points: 13 }]);
assert.equal((await as(A, 'select * from my_lineup(1)')).find(p => p.id === 1).points, 20);
await as(A, 'select save_lineup(2, array[2,3,4,5,6])');
await as(A, 'select save_lineup(2, array[2,3,4,5,7])'); // replace, not append
assert.equal((await as(A, 'select * from my_lineup(2)')).length, 5);
assert.deepEqual(await as(A, 'select * from standings()'), [{ username: 'anna', points: 117 }, { username: 'bob', points: 13 }]);
assert.deepEqual((await as(A, 'select matches_to_sync() id order by 1')).map(r => r.id), [11]); // 10 is >48h old and has ratings
assert.deepEqual((await as(A, 'select day from days order by day')).map(r => r.day), [1, 2]);
// stats: player 4 sat on the bench (0 min) so has no games; match 20 is in the future so day 1 is the last finished day
assert.deepEqual(await as(A, 'select player_id, games, avg_val::float from player_stats where player_id in (1, 4) order by 1'),
  [{ player_id: 1, games: 1, avg_val: 20 }, { player_id: 4, games: 0, avg_val: null }]);
assert.deepEqual((await as(A, 'select day, name, val from top_last_day')).map(r => [r.day, r.name, r.val]), [[1, 'P1', 20], [1, 'P6', 15], [1, 'P3', -2], [1, 'P4', 0]].sort((a, b) => b[2] - a[2] || a[1].localeCompare(b[1])));
await pg.exec(`insert into matches values (12,1,now()-interval '3 days',1,2,2),(13,1,now()-interval '4 days',1,2,2);
  insert into ratings values (12,1,10,20),(13,1,30,20)`);
assert.deepEqual(await as(A, 'select name, games, avg_val::float from top_season'), [{ name: 'P1', games: 3, avg_val: 20 }]);
assert.equal((await as(A, 'select avg_val::float a from player_list where id = 1'))[0].a, 20);
// leagues
const [{ id: L, code }] = await as(A, `select * from create_league('  Amici  ')`);
assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
assert.deepEqual(await as(A, 'select name, is_owner, members::int from my_leagues()'), [{ name: 'Amici', is_owner: true, members: 1 }]);
await rejects(as(A, `select create_league('ab')`), /3 a 40/);
await rejects(as(B, `select join_league('XXXXXX')`), /non valido/);
// RLS (the rest of this file runs as superuser, which bypasses it): B can't see the league before joining
await pg.exec('grant usage on schema public to authenticated; grant select on all tables in schema public to authenticated');
const asAuth = async (uid, sql) => {
  await pg.query(`select set_config('test.uid', $1, false)`, [uid]); await pg.exec('set role authenticated');
  try { return (await pg.query(sql)).rows; } finally { await pg.exec('reset role'); }
};
assert.equal((await asAuth(B, 'select * from leagues')).length, 0);
await as(B, `select join_league(' ${code.toLowerCase()} ')`);
await as(B, `select join_league('${code}')`); // idempotent
assert.equal((await asAuth(B, 'select * from leagues')).length, 1);
assert.equal((await asAuth(B, 'select * from league_members')).length, 2);
assert.deepEqual(await as(A, `select * from standings(null, ${L})`), await as(A, 'select * from standings()'));
assert.deepEqual(await as('', `select * from standings(null, ${L})`), []); // non-members see nothing
// signing up from an invite link joins the league; members without lineups show 0; a bad code never blocks sign-up
const C = '00000000-0000-0000-0000-00000000000c';
await pg.exec(`insert into auth.users values ('${C}', '{"username":"cleo","league":"${code}"}')`);
assert.deepEqual((await as(A, `select username, points from standings(1, ${L})`)).at(-1), { username: 'cleo', points: 0 });
await pg.exec(`insert into auth.users values (gen_random_uuid(), '{"username":"dino","league":"NOPE00"}')`);
assert.deepEqual((await as(B, `select username from league_roster(${L})`)).map(r => r.username), ['anna', 'bob', 'cleo']);
// owner powers
await rejects(as(B, `select remove_member(${L}, '${C}')`), /Solo chi/);
await rejects(as(A, `select leave_league(${L})`), /eliminarla/);
await as(A, `select remove_member(${L}, '${C}')`);
await as(A, `select rename_league(${L}, 'Amici del giovedì')`);
assert.equal((await as(B, 'select name from my_leagues()'))[0].name, 'Amici del giovedì');
await as(B, `select leave_league(${L})`);
assert.deepEqual(await as(B, 'select * from my_leagues()'), []);
await rejects(as(B, `select delete_league(${L})`), /Solo chi/);
await as(A, `select delete_league(${L})`);
assert.equal((await pg.query('select count(*)::int n from league_members')).rows[0].n, 0);

// delete_account: anonymous refused; the user's profile and lineups disappear, others untouched
await rejects(as('', 'select delete_account()'), /Accesso/);
await as(B, 'select delete_account()');
assert.deepEqual((await as(A, 'select username from profiles order by 1')).map(r => r.username), ['anna', 'cleo', 'dino']);
assert.equal((await pg.query(`select count(*)::int n from lineups where user_id = '${B}'`)).rows[0].n, 0);
assert.ok((await pg.query(`select count(*)::int n from lineups where user_id = '${A}'`)).rows[0].n > 0);
await pg.exec(`update matches set home_score = 80, away_score = 70 where id = 10;
  update matches set home_score = 60, away_score = 75 where id in (11, 12, 13);
  update matches set home_score = 0, away_score = 0 where id = 20`); // 20 not played yet: ignored
assert.deepEqual(await as(A, 'select team_id, wins::int, losses::int from team_records order by 1'),
  [{ team_id: 1, wins: 1, losses: 3 }, { team_id: 2, wins: 3, losses: 1 }]);
console.log('ok');
