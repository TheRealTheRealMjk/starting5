// supabase-js 2.118.0 self-hosted (docs/vendor/supabase.js, UMD → window.supabase): no third-party CDN sees visitors' IPs.
const { createClient } = window.supabase;
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Unwrap a supabase-js result, surfacing the server-side message (e.g. from save_lineup).
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

let me = null, days = [], players = [], picked = new Set();
let matches = [], teamName = new Map(), records = new Map(); // team id → name, team id → {wins, losses}
let leagues = [], league = ''; // league = id shown in the standings, '' = everyone
// Invite link ?lega=CODE: joined right after login, or passed to signUp so the server joins it at account creation.
let invite = new URLSearchParams(location.search).get('lega')?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

const isLocked = d => Date.parse(d.starts_at) <= Date.now();
const dayLabel = d => `${d.day}ª giornata — ${new Date(d.starts_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}${isLocked(d) ? ' 🔒' : ''}`;
const currentDay = () => (days.find(d => !isLocked(d)) ?? days.at(-1))?.day;
// '' while the team_records view is missing (before migration-004), so nobody sees a fake 0-0
const record = id => { if (!records) return ''; const r = records.get(id); return r ? `${r.wins}-${r.losses}` : '0-0'; };
// The match a team plays on a day: { opp: name, home: bool, oppRecord: 'W-L' } or undefined.
function matchup(team, day) {
  const m = matches.find(m => m.day === day && (teamName.get(m.home_id) === team || teamName.get(m.away_id) === team));
  if (!m) return;
  const home = teamName.get(m.home_id) === team, opp = home ? m.away_id : m.home_id;
  return { opp: teamName.get(opp), home, oppRecord: record(opp) };
}
const lastPlayedDay = () => (days.findLast(isLocked) ?? days[0])?.day;

function fillDaySelect(sel, selected) {
  sel.innerHTML = days.map(d => `<option value="${d.day}" ${d.day === selected ? 'selected' : ''}>${esc(dayLabel(d))}</option>`).join('');
}

// ---------- tabs ----------
let tab = 'home';
function showTab(name) {
  tab = name;
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== `tab-${name}`);
  if (name === 'day') loadStandings($('#day-table'), $('#standings-day').value);
  if (name === 'total') loadStandings($('#total-table'));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

async function loadStandings(tbody, day) {
  const rows = await q(sb.rpc('standings', { ...(day && { p_day: Number(day) }), ...(league && { p_league: Number(league) }) }));
  tbody.innerHTML = rows.length
    ? rows.map((r, i) => `<tr class="${r.username === me?.username ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.points}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Nessuna formazione per ora</td></tr>';
}
$('#standings-day').onchange = e => loadStandings($('#day-table'), e.target.value);
document.querySelectorAll('.standings-league').forEach(sel => sel.onchange = () => { league = sel.value; fillLeagueSelects(); showTab(tab); });

// ---------- leagues ----------
function fillLeagueSelects() {
  if (!leagues.some(l => String(l.id) === league)) league = '';
  document.querySelectorAll('.standings-league').forEach(sel => {
    sel.innerHTML = `<option value="">Tutti</option>${leagues.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}`;
    sel.value = league;
    sel.parentElement.hidden = !leagues.length;
  });
}
const leaguesMsg = t => $('#leagues-msg').textContent = t;

async function loadLeagues() {
  leagues = me ? await q(sb.rpc('my_leagues')) : [];
  fillLeagueSelects();
  $('#leagues-list').innerHTML = leagues.length ? leagues.map(l => `
    <article class="card league" data-id="${l.id}">
      <header><h3>${esc(l.name)}</h3><small>${l.members} ${l.members == 1 ? 'membro' : 'membri'} · codice <code>${esc(l.code)}</code></small></header>
      <div class="row">
        <button class="small" data-act="share">Invita amici</button>
        <button class="small ghost" data-act="standings">Classifica</button>
        ${l.is_owner ? '<button class="small ghost" data-act="rename">Rinomina</button><button class="small ghost" data-act="delete">Elimina</button>'
                     : '<button class="small ghost" data-act="leave">Esci</button>'}
      </div>
      <details><summary>Membri</summary><ul class="roster"></ul></details>
    </article>`).join('') : '<p class="hint">Non fai ancora parte di nessuna lega: creane una e invita i tuoi amici.</p>';
}

async function joinInvite() {
  const code = invite;
  invite = null;
  history.replaceState(null, '', location.pathname + location.hash); // drop ?lega= so a reload doesn't retry
  try {
    await q(sb.rpc('join_league', { p_code: code }));
    await loadLeagues();
    showTab('leagues');
    leaguesMsg(`Sei entrato nella lega «${leagues.find(l => l.code === code)?.name ?? code}».`);
  } catch (err) { showTab('leagues'); leaguesMsg(err.message); }
}

const inviteLink = code => `${location.origin}${location.pathname}?lega=${code}`;
async function shareLeague(l) {
  const url = inviteLink(l.code), text = `Entra nella mia lega «${l.name}» su Starting5!`;
  if (navigator.share) {
    try { return await navigator.share({ title: 'Starting5', text, url }); } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text} ${url}`); leaguesMsg('Link di invito copiato: incollalo su WhatsApp o dove vuoi.'); }
  catch { prompt('Copia questo link e mandalo ai tuoi amici:', url); }
}

async function loadRoster(card) {
  const l = leagues.find(x => x.id == card.dataset.id);
  const rows = await q(sb.rpc('league_roster', { p_league: l.id }));
  card.querySelector('.roster').innerHTML = rows.map(r => `<li><span>${esc(r.username)}</span>${r.is_owner ? '<small class="tag">creatore</small>'
    : l.is_owner ? `<button class="small ghost" data-act="remove" data-user="${r.user_id}" data-name="${esc(r.username)}">Rimuovi</button>` : ''}</li>`).join('');
}
// 'toggle' doesn't bubble: listen in the capture phase
$('#leagues-list').addEventListener('toggle', e => { if (e.target.open) loadRoster(e.target.closest('.league')).catch(err => leaguesMsg(err.message)); }, true);

$('#leagues-list').onclick = async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.league'), l = leagues.find(x => x.id == card.dataset.id);
  try {
    switch (btn.dataset.act) {
      case 'share': return await shareLeague(l);
      case 'standings': league = String(l.id); fillLeagueSelects(); return showTab('total');
      case 'rename': {
        const name = prompt('Nuovo nome della lega', l.name);
        if (!name || name.trim() === l.name) return;
        await q(sb.rpc('rename_league', { p_league: l.id, p_name: name }));
        break;
      }
      case 'delete':
        if (!confirm(`Eliminare la lega «${l.name}»? La classifica della lega sparisce per tutti i membri (le formazioni restano).`)) return;
        await q(sb.rpc('delete_league', { p_league: l.id }));
        break;
      case 'leave':
        if (!confirm(`Uscire dalla lega «${l.name}»?`)) return;
        await q(sb.rpc('leave_league', { p_league: l.id }));
        break;
      case 'remove':
        if (!confirm(`Rimuovere ${btn.dataset.name} dalla lega «${l.name}»?`)) return;
        await q(sb.rpc('remove_member', { p_league: l.id, p_user: btn.dataset.user }));
        break;
    }
    leaguesMsg('');
    await loadLeagues();
  } catch (err) { leaguesMsg(err.message); }
};

$('#league-create').onsubmit = async e => {
  e.preventDefault();
  try {
    const [{ code }] = await q(sb.rpc('create_league', { p_name: e.target.elements.name.value }));
    e.target.reset();
    await loadLeagues();
    leaguesMsg(`Lega creata! Codice ${code}: premi «Invita amici» per mandare il link.`);
  } catch (err) { leaguesMsg(err.message); }
};
$('#league-join').onsubmit = async e => {
  e.preventDefault();
  invite = e.target.elements.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  e.target.reset();
  await joinInvite();
};

// ---------- account ----------
async function setUser(user) {
  const justLoggedIn = user && !me; // not on token refreshes: those must not move the user off their tab
  me = user ? { id: user.id, username: (await q(sb.from('profiles').select('username').eq('id', user.id).maybeSingle()))?.username } : null;
  $('#account').innerHTML = me ? `<span class="user">${esc(me.username)}</span> <button id="logout" class="ghost small">Esci</button>` : '';
  if (me) $('#logout').onclick = () => sb.auth.signOut();
  document.body.classList.toggle('logged', !!me);
  $('#auth').hidden = !!me;
  $('#login-hint').hidden = !!me;
  $('[data-tab="lineup"]').hidden = !me;
  if (!me && tab === 'lineup') showTab('home');
  $('#lineup').hidden = !me;
  $('#delete-wrap').hidden = !me;
  $('#leagues-hint').hidden = !!me;
  $('#leagues-box').hidden = !me;
  $('#invite-msg').hidden = !(invite && !me);
  if (me) loadLineup();
  if (me && justLoggedIn) showTab('lineup');
  await loadLeagues();
  if (me && invite) await joinInvite();
}

$('#delete-account').onclick = async () => {
  if (!confirm(`Eliminare definitivamente l'account "${me.username}"? Email, username, tutte le formazioni e le leghe che hai creato verranno cancellati. Non si può annullare.`)) return;
  try {
    await q(sb.rpc('delete_account'));
    await sb.auth.signOut({ scope: 'local' }); // the server session is already gone with the user
    alert('Account eliminato.');
  } catch (err) { alert(err.message); }
};

$('#auth').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = f.get('email'), password = f.get('password'), username = f.get('username').trim();
  const msg = $('#auth-msg');
  const buttons = e.target.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true); // no double submit while waiting
  msg.textContent = 'Attendere…';
  try {
    if (e.submitter.value === 'login') {
      await q(sb.auth.signInWithPassword({ email, password }));
      msg.textContent = '';
    } else {
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) throw new Error('Username: 3-20 caratteri tra lettere, numeri, _ . -');
      const taken = await q(sb.from('profiles').select('id').ilike('username', username.replace(/[_%\\]/g, '\\$&')));
      if (taken.length) throw new Error('Username già registrato. Se ti sei appena registrato tu, conferma dal link nella mail e poi clicca Accedi.');
      const { session } = await q(sb.auth.signUp({ email, password, options: { data: { username, ...(invite && { league: invite }) }, emailRedirectTo: location.href.split('#')[0] } }));
      msg.textContent = session ? '' : `Registrazione fatta! Abbiamo mandato una mail a ${email}: clicca il link per confermare, poi accedi qui. Non la trovi? Guarda nella cartella Spam e segnala «Non è spam».`;
    }
  } catch (err) {
    msg.textContent = /email not confirmed/i.test(err.message) ? 'Email non ancora confermata: clicca il link nella mail che ti abbiamo mandato (se non la trovi, guarda nella cartella Spam).'
      : /invalid login credentials/i.test(err.message) ? 'Email o password errate.'
      : /rate limit/i.test(err.message) ? 'Troppe richieste, riprova tra qualche minuto.'
      : err.message;
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
};

// ---------- lineup ----------
const selectedDay = () => days.find(d => d.day === Number($('#lineup-day').value));

async function loadLineup() {
  const day = selectedDay();
  if (!day) return;
  const mine = await q(sb.rpc('my_lineup', { p_day: day.day }));
  const locked = isLocked(day);
  picked = new Set(mine.map(p => p.id));
  $('#picker').hidden = locked;
  $('#lineup-status').textContent = locked
    ? `Giornata bloccata. Totale: ${mine.reduce((s, p) => s + (p.points ?? 0), 0)} punti`
    : `Si blocca il ${new Date(day.starts_at).toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' })}`;
  renderPicks(locked ? mine : null);
  renderPlayers();
}
$('#lineup-day').onchange = loadLineup;

function renderPicks(scored) {
  const list = scored ?? [...picked].map(id => players.find(p => p.id === id)).filter(Boolean);
  $('#picks').innerHTML = [0, 1, 2, 3, 4].map(i => {
    const p = list[i];
    if (!p) return `<li class="slot"><span class="pos">${i + 1}</span><small>Scegli un giocatore</small></li>`;
    return `<li class="slot filled"><span class="pos">${i + 1}</span><b>${esc(p.name)}</b><small>${esc(p.team)}</small>${scored
      ? `<em>${p.points ?? 0}</em>`
      : `<button class="remove" data-id="${p.id}" aria-label="Togli ${esc(p.name)}">×</button>`}</li>`;
  }).join('');
  $('#save').disabled = picked.size !== 5;
  $('#save').textContent = `Salva formazione (${picked.size}/5)`;
}

// No search: the 50 best season averages. With a search: every matching player. Each row shows that day's opponent.
function renderPlayers() {
  const s = $('#search').value.trim().toLowerCase(), day = selectedDay()?.day;
  const shown = s ? players.filter(p => `${p.name} ${p.team}`.toLowerCase().includes(s)) : players.slice(0, 50);
  const vs = team => {
    const g = matchup(team, day);
    return g ? `vs ${esc(g.opp)}${g.oppRecord && ` <b title="Record ${esc(g.opp)}: vinte-perse">${g.oppRecord}</b>`} · ${g.home ? 'in casa' : 'in trasferta'}` : 'non gioca questa giornata';
  };
  $('#players').innerHTML = `<fieldset><legend>${s ? `${shown.length} ${shown.length === 1 ? 'giocatore trovato' : 'giocatori trovati'}` : 'I migliori 50 per valutazione media'}</legend>${shown.map(p => `
    <label><input type="checkbox" value="${p.id}" ${picked.has(p.id) ? 'checked' : ''}
      ${!picked.has(p.id) && picked.size >= 5 ? 'disabled' : ''}>
      <span class="nm"><span>${esc(p.name)} <small>${esc(p.role)}</small></span><span class="meta">${esc(p.team)}</span><span class="opp">${vs(p.team)}</span></span>
      <span class="avg" title="${p.games ? `Valutazione media in ${p.games} partite` : 'Nessuna partita giocata'}">${p.avg_val == null ? '–' : Number(p.avg_val).toFixed(1)}</span></label>`).join('')}</fieldset>`;
}
$('#picks').onclick = e => {
  const id = Number(e.target.closest('.remove')?.dataset.id);
  if (!id) return;
  picked.delete(id);
  const box = $(`#players input[value="${id}"]`);
  if (box) box.checked = false;
  renderPicks();
  document.querySelectorAll('#players input').forEach(i => i.disabled = !i.checked && picked.size >= 5);
};
$('#search').oninput = renderPlayers;
$('#players').onchange = e => {
  const id = Number(e.target.value);
  e.target.checked ? picked.add(id) : picked.delete(id);
  renderPicks();
  // update in place so focus and scroll position survive
  document.querySelectorAll('#players input').forEach(i => i.disabled = !i.checked && picked.size >= 5);
};

$('#save').onclick = async () => {
  try {
    await q(sb.rpc('save_lineup', { p_day: selectedDay().day, p_players: [...picked] }));
    $('#lineup-status').textContent = 'Formazione salvata ✔';
  } catch (err) { alert(err.message); }
};

// ---------- boot ----------
let topSeason, topDay, teams, recs;
[days, players, topSeason, topDay, matches, teams, recs] = await Promise.all([
  q(sb.from('days').select('*').order('day')),
  q(sb.from('player_list').select('*').order('avg_val', { ascending: false, nullsFirst: false }).order('name')),
  q(sb.from('top_season').select('*')),
  q(sb.from('top_last_day').select('*')),
  q(sb.from('matches').select('day, starts_at, home_id, away_id').order('starts_at')),
  q(sb.from('teams').select('id, name')),
  q(sb.from('team_records').select('*')).catch(() => null), // view arrives with migration-004: the page must work without it
]);
teamName = new Map(teams.map(t => [t.id, t.name]));
records = recs && new Map(recs.map(r => [r.team_id, r]));
const topList = (rows, val) => rows.length
  ? rows.map(r => `<li><span class="nm">${esc(r.name)} <small>${esc(r.team)}</small></span><b>${val(r)}</b></li>`).join('')
  : '<li class="empty">Ancora nessun dato</li>';
$('#top-season').innerHTML = topList(topSeason, r => Number(r.avg_val).toFixed(1));
$('#top-day').innerHTML = topList(topDay, r => r.val);
if (topDay[0]) $('#top-day-title').textContent = `Top 5 · ${topDay[0].day}ª giornata`;
const nextDay = currentDay(), nextGames = matches.filter(m => m.day === nextDay);
if (nextGames.length) {
  $('#next-games-title').textContent = `Prossima giornata · ${nextDay}ª`;
  const team = id => `<span class="team">${esc(teamName.get(id))} <small>${record(id)}</small></span>`;
  $('#next-games-list').innerHTML = nextGames.map(m => `<li><time datetime="${m.starts_at}">${esc(new Date(m.starts_at).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }))}<b>${new Date(m.starts_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</b></time>${team(m.home_id)}<span class="dash">–</span>${team(m.away_id)}</li>`).join('');
  $('#next-games').hidden = false;
}
fillDaySelect($('#lineup-day'), currentDay());
fillDaySelect($('#standings-day'), lastPlayedDay());
// setTimeout: supabase-js advises against awaiting its calls inside this callback
sb.auth.onAuthStateChange((_event, session) => setTimeout(() => setUser(session?.user ?? null)));
