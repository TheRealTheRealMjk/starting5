import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
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

const isLocked = d => Date.parse(d.starts_at) <= Date.now();
const dayLabel = d => `${d.day}ª giornata — ${new Date(d.starts_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}${isLocked(d) ? ' 🔒' : ''}`;
const currentDay = () => (days.find(d => !isLocked(d)) ?? days.at(-1))?.day;
const lastPlayedDay = () => (days.findLast(isLocked) ?? days[0])?.day;

function fillDaySelect(sel, selected) {
  sel.innerHTML = days.map(d => `<option value="${d.day}" ${d.day === selected ? 'selected' : ''}>${esc(dayLabel(d))}</option>`).join('');
}

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== `tab-${b.dataset.tab}`);
  if (b.dataset.tab === 'day') loadStandings($('#day-table'), $('#standings-day').value);
  if (b.dataset.tab === 'total') loadStandings($('#total-table'));
});

async function loadStandings(tbody, day) {
  const rows = await q(sb.rpc('standings', day ? { p_day: Number(day) } : {}));
  tbody.innerHTML = rows.length
    ? rows.map((r, i) => `<tr class="${r.username === me?.username ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.points}</td></tr>`).join('')
    : '<tr><td colspan="3">Nessuna formazione</td></tr>';
}
$('#standings-day').onchange = e => loadStandings($('#day-table'), e.target.value);

// ---------- account ----------
async function setUser(user) {
  me = user ? { id: user.id, username: (await q(sb.from('profiles').select('username').eq('id', user.id).maybeSingle()))?.username } : null;
  $('#account').innerHTML = me ? `${esc(me.username)} <button id="logout" class="secondary">Esci</button>` : '';
  if (me) $('#logout').onclick = () => sb.auth.signOut();
  $('#auth').hidden = !!me;
  $('#lineup').hidden = !me;
  if (me) loadLineup();
}

$('#auth').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = f.get('email'), password = f.get('password'), username = f.get('username').trim();
  try {
    if (e.submitter.value === 'login') {
      await q(sb.auth.signInWithPassword({ email, password }));
    } else {
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) throw new Error('Username: 3-20 caratteri tra lettere, numeri, _ . -');
      const taken = await q(sb.from('profiles').select('id').ilike('username', username.replace(/[_%\\]/g, '\\$&')));
      if (taken.length) throw new Error('Username già in uso');
      const { session } = await q(sb.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: location.href.split('#')[0] } }));
      if (!session) alert('Ti abbiamo mandato una mail: clicca il link per confermare e poi accedi.');
    }
  } catch (err) { alert(err.message); }
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
  $('#picks').innerHTML = list.length
    ? list.map(p => `<li>${esc(p.name)} <small>${esc(p.team)}</small>${scored ? ` <b>${p.points ?? 0}</b>` : ''}</li>`).join('')
    : '<li class="empty">Nessun giocatore scelto</li>';
  $('#save').disabled = picked.size !== 5;
  $('#save').textContent = `Salva formazione (${picked.size}/5)`;
}

function renderPlayers() {
  const s = $('#search').value.trim().toLowerCase();
  const shown = players.filter(p => !s || `${p.name} ${p.team}`.toLowerCase().includes(s));
  const teams = Map.groupBy(shown, p => p.team);
  $('#players').innerHTML = [...teams].map(([team, ps]) => `<fieldset><legend>${esc(team)}</legend>${ps.map(p => `
    <label><input type="checkbox" value="${p.id}" ${picked.has(p.id) ? 'checked' : ''}
      ${!picked.has(p.id) && picked.size >= 5 ? 'disabled' : ''}>
      ${esc(p.number)} ${esc(p.name)} <small>${esc(p.role)}</small></label>`).join('')}</fieldset>`).join('');
}
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
[days, players] = await Promise.all([
  q(sb.from('days').select('*').order('day')),
  q(sb.from('player_list').select('*').order('team').order('name')),
]);
fillDaySelect($('#lineup-day'), currentDay());
fillDaySelect($('#standings-day'), lastPlayedDay());
// setTimeout: supabase-js advises against awaiting its calls inside this callback
sb.auth.onAuthStateChange((_event, session) => setTimeout(() => setUser(session?.user ?? null)));
