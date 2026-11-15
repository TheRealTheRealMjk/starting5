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
  insert into players (id, team_id, name) select i, i % 2 + 1, 'P' || i from generate_series(1, 7) i;
  -- day 1 is already locked, so seed it directly
  insert into lineups select '${A}', 1, unnest(array[1,2,3,4,5]);
  insert into lineups select '${B}', 1, unnest(array[3,4,5,6,7]);
  insert into ratings values (10,1,20),(10,3,-2),(11,6,15),(20,2,99);
`);
const as = async (uid, sql, params) => { await pg.query(`select set_config('test.uid', $1, false)`, [uid]); return (await pg.query(sql, params)).rows; };
const rejects = (p, re) => assert.rejects(p, re);

await rejects(as(A, 'select save_lineup(1, array[1,2,3,4,5])'), /bloccata/);
await rejects(as(A, 'select save_lineup(2, array[1,1,2,3,4])'), /5 giocatori/);
await rejects(as(A, 'select save_lineup(2, array[1,2,3,4,99])'), /non valido/);
await rejects(as(A, 'select save_lineup(9, array[1,2,3,4,5])'), /inesistente/);
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
console.log('ok');
