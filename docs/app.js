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
    : '<tr><td colspan="3" class="empty">Nessuna formazione per ora</td></tr>';
}
$('#standings-day').onchange = e => loadStandings($('#day-table'), e.target.value);

// ---------- account ----------
async function setUser(user) {
  me = user ? { id: user.id, username: (await q(sb.from('profiles').select('username').eq('id', user.id).maybeSingle()))?.username } : null;
  $('#account').innerHTML = me ? `<span class="user">${esc(me.username)}</span> <button id="logout" class="ghost small">Esci</button>` : '';
  if (me) $('#logout').onclick = () => sb.auth.signOut();
  document.body.classList.toggle('logged', !!me);
  $('#auth').hidden = !!me;
  $('#login-hint').hidden = !!me;
  $('#lineup').hidden = !me;
  if (me) loadLineup();
}

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
      const { session } = await q(sb.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: location.href.split('#')[0] } }));
      msg.textContent = session ? '' : `Registrazione fatta! Abbiamo mandato una mail a ${email}: clicca il link per confermare, poi accedi qui.`;
    }
  } catch (err) {
    msg.textContent = /email not confirmed/i.test(err.message) ? 'Email non ancora confermata: clicca il link nella mail che ti abbiamo mandato.'
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

function renderPlayers() {
  const s = $('#search').value.trim().toLowerCase();
  const shown = players.filter(p => !s || `${p.name} ${p.team}`.toLowerCase().includes(s));
  const teams = Map.groupBy(shown, p => p.team);
  $('#players').innerHTML = [...teams].map(([team, ps]) => `<fieldset><legend>${esc(team)}</legend>${ps.map(p => `
    <label><input type="checkbox" value="${p.id}" ${picked.has(p.id) ? 'checked' : ''}
      ${!picked.has(p.id) && picked.size >= 5 ? 'disabled' : ''}>
      <span class="no">${esc(p.number)}</span> <span class="nm">${esc(p.name)} <small>${esc(p.role)}</small></span>
      <span class="avg" title="${p.games ? `Valutazione media in ${p.games} partite` : 'Nessuna partita giocata'}">${p.avg_val == null ? '–' : Number(p.avg_val).toFixed(1)}</span></label>`).join('')}</fieldset>`).join('');
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
let topSeason, topDay;
[days, players, topSeason, topDay] = await Promise.all([
  q(sb.from('days').select('*').order('day')),
  q(sb.from('player_list').select('*').order('team').order('avg_val', { ascending: false, nullsFirst: false }).order('name')),
  q(sb.from('top_season').select('*')),
  q(sb.from('top_last_day').select('*')),
]);
const topList = (rows, val) => rows.length
  ? rows.map(r => `<li><span class="nm">${esc(r.name)} <small>${esc(r.team)}</small></span><b>${val(r)}</b></li>`).join('')
  : '<li class="empty">Ancora nessun dato</li>';
$('#top-season').innerHTML = topList(topSeason, r => Number(r.avg_val).toFixed(1));
$('#top-day').innerHTML = topList(topDay, r => r.val);
if (topDay[0]) $('#top-day-title').textContent = `Top 5 · ${topDay[0].day}ª giornata`;
fillDaySelect($('#lineup-day'), currentDay());
fillDaySelect($('#standings-day'), lastPlayedDay());
// setTimeout: supabase-js advises against awaiting its calls inside this callback
sb.auth.onAuthStateChange((_event, session) => setTimeout(() => setUser(session?.user ?? null)));
