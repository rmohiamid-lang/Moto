// Statistiques : activité, série, réussite, prévision et répartition des cartes.
import * as db from './db.js';
import { dayNumber, dayStartTs } from './scheduler.js';
import { state } from './state.js';
import { $, showView, plural } from './ui.js';

const WEEKS = 26;

export function bindStats() {
  $('#st-back').onclick = () => state.goHome();
  $('#st-deck').onchange = () => render();
  // Sur tablette, pas de survol : un toucher affiche le détail d'une case ou d'une barre.
  $('#stats').addEventListener('click', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) {
      const box = el.closest('.st-card').querySelector('.st-tip');
      if (box) box.textContent = el.dataset.tip;
    }
  });
}

export async function openStats(deckName = '') {
  showView('stats');
  const decks = (await db.getAll('decks')).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  const sel = $('#st-deck');
  sel.innerHTML = '';
  sel.add(new Option('Toute la collection', ''));
  for (const d of decks) sel.add(new Option(d.name.split('::').join(' › '), d.name));
  sel.value = decks.some((d) => d.name === deckName) ? deckName : '';
  await render();
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

async function render() {
  const s = state.settings;
  const deckName = $('#st-deck').value;
  const [allCards, decks, revlog] = await Promise.all([db.getAll('cards'), db.getAll('decks'), db.getAll('revlog')]);
  const inDeck = new Set(decks.filter((d) => !deckName || d.name === deckName || d.name.startsWith(`${deckName}::`)).map((d) => d.id));
  const cards = allCards.filter((c) => inDeck.has(c.did));
  const cardIds = new Set(cards.map((c) => c.id));
  const logs = revlog.filter((l) => cardIds.has(l.cid));
  const today = dayNumber(Date.now(), s);

  // Révisions par jour.
  const perDay = new Map();
  for (const l of logs) {
    const d = dayNumber(l.id, s);
    const e = perDay.get(d) || { n: 0, time: 0 };
    e.n++;
    e.time += l.time || 0;
    perDay.set(d, e);
  }
  const todayStats = perDay.get(today) || { n: 0, time: 0 };
  let streak = 0;
  for (let d = perDay.has(today) ? today : today - 1; perDay.has(d); d--) streak++;
  let best = 0, run = 0;
  for (const d of [...perDay.keys()].sort((a, b) => a - b)) {
    run = perDay.has(d - 1) ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const recent = logs.filter((l) => l.state === 2 && dayNumber(l.id, s) > today - 30);
  const success = recent.length ? Math.round(100 * recent.filter((l) => l.rating > 1).length / recent.length) : null;

  $('#st-tiles').innerHTML = [
    tile('Aujourd’hui', plural(todayStats.n, 'révision'), todayStats.n ? `${Math.max(1, Math.round(todayStats.time / 60000))} min` : 'Rien pour l’instant'),
    tile('Série', `🔥 ${plural(streak, 'jour')}`, `Record : ${plural(best, 'jour')}`),
    tile('Réussite (30 j)', success === null ? '—' : `${success} %`, success === null ? 'Pas encore de révisions' : `${plural(recent.length, 'révision')}`),
    tile('Cartes', String(cards.length), `${plural(cards.filter((c) => c.state === 0 && !c.suspended).length, 'nouvelle')}`),
  ].join('');

  renderHeatmap(perDay, today);
  renderForecast(cards, today);
  renderBreakdown(cards);
}

function tile(label, value, sub) {
  return `<div class="st-tile"><div class="st-label">${label}</div><div class="st-value">${value}</div><div class="st-sub">${sub}</div></div>`;
}

function renderHeatmap(perDay, today) {
  const s = state.settings;
  // Colonnes = semaines (lundi en haut), dernière colonne = semaine en cours.
  const todayDate = new Date(dayStartTs(today, s));
  const dow = (todayDate.getDay() + 6) % 7;
  const start = today - dow - (WEEKS - 1) * 7;
  const max = Math.max(1, ...[...perDay.entries()].filter(([d]) => d >= start).map(([, e]) => e.n));
  const level = (n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  let cells = '';
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const day = start + w * 7 + d;
      if (day > today) continue;
      const n = perDay.get(day)?.n || 0;
      const date = dateFmt.format(new Date(dayStartTs(day, s)));
      const tip = `${date} : ${n ? plural(n, 'révision') : 'aucune révision'}`;
      cells += `<rect x="${w * 14}" y="${d * 14}" width="11" height="11" rx="2" class="hm l${level(n)}" data-tip="${tip}"><title>${tip}</title></rect>`;
    }
  }
  const active = [...perDay.keys()].filter((d) => d >= start).length;
  $('#st-heatmap').innerHTML = `
    <svg viewBox="0 0 ${WEEKS * 14} ${7 * 14}" class="hm-svg" role="img" aria-label="Activité des ${WEEKS} dernières semaines">${cells}</svg>
    <div class="hm-legend"><span>Moins</span>${[0, 1, 2, 3, 4].map((l) => `<i class="hm l${l}"></i>`).join('')}<span>Plus</span></div>
    <p class="st-tip muted">${plural(active, 'jour')} de révision sur les ${WEEKS} dernières semaines. Touchez une case pour le détail.</p>`;
}

function renderForecast(cards, today) {
  const days = 30;
  const counts = new Array(days).fill(0);
  for (const c of cards) {
    if (c.suspended || c.state !== 2) continue;
    const i = Math.max(0, c.due - today);
    if (i < days) counts[i]++;
  }
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const W = 600, H = 150, bw = W / days;
  const bars = counts.map((n, i) => {
    const h = n ? Math.max(3, (n / max) * (H - 20)) : 0;
    const label = i === 0 ? 'Aujourd’hui (avec les retards)' : i === 1 ? 'Demain' : `Dans ${i} jours`;
    const tip = `${label} : ${plural(n, 'carte')}`;
    return `<g data-tip="${tip}"><title>${tip}</title>
      <rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>
      ${n ? `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="3" class="fc-bar"/>` : ''}</g>`;
  }).join('');
  const ticks = [0, 7, 14, 21, 28].map((i) => `<text x="${i * bw + bw / 2}" y="${H + 16}" class="fc-axis" text-anchor="middle">${i === 0 ? 'Auj.' : `+${i} j`}</text>`).join('');
  $('#st-forecast').innerHTML = `
    <svg viewBox="0 -4 ${W} ${H + 24}" class="fc-svg" role="img" aria-label="Révisions prévues sur 30 jours">
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="fc-base"/>
      <text x="0" y="8" class="fc-axis">${max}</text>
      <line x1="24" y1="4" x2="${W}" y2="4" class="fc-grid"/>
      ${bars}${ticks}
    </svg>
    <p class="st-tip muted">${total
    ? `${plural(total, 'révision')} prévue${total > 1 ? 's' : ''} dans les 30 prochains jours. Touchez une barre pour le détail.`
    : 'Aucune révision prévue pour l’instant : elles apparaîtront quand vous aurez appris des cartes.'}</p>`;
}

function renderBreakdown(cards) {
  const groups = [
    ['Nouvelles', cards.filter((c) => !c.suspended && c.state === 0).length],
    ['En apprentissage', cards.filter((c) => !c.suspended && (c.state === 1 || c.state === 3)).length],
    ['Jeunes (moins de 21 j)', cards.filter((c) => !c.suspended && c.state === 2 && c.ivl < 21).length],
    ['Matures (21 j et plus)', cards.filter((c) => !c.suspended && c.state === 2 && c.ivl >= 21).length],
    ['Suspendues', cards.filter((c) => c.suspended).length],
  ];
  const total = Math.max(1, cards.length);
  $('#st-breakdown').innerHTML = groups.map(([label, n]) => `
    <div class="bd-row">
      <span class="bd-label">${label}</span>
      <span class="bd-track"><span class="bd-fill" style="width:${(100 * n) / total}%"></span></span>
      <span class="bd-num">${n}</span>
    </div>`).join('');
}
