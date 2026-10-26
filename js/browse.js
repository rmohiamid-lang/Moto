// Navigateur de cartes : recherche, filtres et actions groupées.
import * as db from './db.js';
import * as col from './collection.js';
import { stripHtml, escapeHtml } from './template.js';
import { dayNumber, formatInterval, resetCard } from './scheduler.js';
import { state } from './state.js';
import { $, $$, toast, showView, plural, normalize } from './ui.js';
import { openEditor } from './editor.js';

const PAGE = 150;

const br = {
  rows: [],        // toutes les cartes enrichies
  results: [],     // cartes correspondant à la recherche
  shown: PAGE,
  selected: new Set(),
};

export function bindBrowse() {
  $('#br-back').onclick = () => state.goHome();
  let timer;
  $('#br-search').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
  $('#br-deck').onchange = search;
  $('#br-state').onchange = search;
  $('#br-more').onclick = () => { br.shown += PAGE; render(); };
  $('#br-all').onchange = () => {
    if ($('#br-all').checked) br.results.forEach((r) => br.selected.add(r.card.id));
    else br.selected.clear();
    render();
  };
  $('#br-list').addEventListener('click', (e) => {
    const row = e.target.closest('.br-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest('.br-check')) {
      if (e.target.checked) br.selected.add(id); else br.selected.delete(id);
      updateSelection();
      return;
    }
    const r = br.rows.find((x) => x.card.id === id);
    if (r) openEditor({ noteId: r.card.nid, onClose: async () => { showView('browse'); await reload(); } });
  });
  for (const b of $$('[data-bulk]')) b.onclick = () => bulk(b.dataset.bulk);
}

export async function openBrowser({ deckName = '', query = '' } = {}) {
  showView('browse');
  $('#br-search').value = query;
  br.selected.clear();
  await reload(deckName);
}

async function reload(deckName) {
  const [cards, notes, decks] = await Promise.all([db.getAll('cards'), db.getAll('notes'), db.getAll('decks')]);
  const notesById = new Map(notes.map((n) => [n.id, n]));
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const sel = $('#br-deck');
  const keep = deckName ?? sel.value;
  sel.innerHTML = '';
  sel.add(new Option('Tous les paquets', ''));
  for (const d of [...decks].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))) {
    sel.add(new Option(`${'  '.repeat(d.name.split('::').length - 1)}${d.name.split('::').pop()}`, d.name));
  }
  sel.value = decks.some((d) => d.name === keep) ? keep : '';
  br.rows = cards.map((card) => {
    const note = notesById.get(card.nid) || { fields: [], tags: [] };
    const plain = note.fields.map((f) => stripHtml(f).replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1'));
    return {
      card,
      note,
      deck: deckById.get(card.did)?.name || '',
      q: plain[0] || '',
      a: plain[1] || '',
      text: normalize(plain.join(' ')),
      tags: note.tags.map((t) => t.toLowerCase()),
    };
  });
  search();
}

function parseQuery(q) {
  const out = [];
  for (const m of q.matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    out.push({ neg: !!m[1], key: (m[2] || '').toLowerCase(), value: (m[3] ?? m[4] ?? '').toLowerCase() });
  }
  return out;
}

function matchName(name, value) {
  const n = name.toLowerCase();
  if (value.endsWith('*')) return n.startsWith(value.slice(0, -1));
  return n === value || n.startsWith(`${value}::`);
}

function matches(r, t, today) {
  const c = r.card;
  switch (t.key) {
    case 'tag': return r.tags.some((tag) => matchName(tag, t.value));
    case 'deck': return matchName(r.deck, t.value);
    case 'is':
      if (t.value === 'new') return c.state === 0;
      if (t.value === 'learn') return c.state === 1 || c.state === 3;
      if (t.value === 'review') return c.state === 2;
      if (t.value === 'due') return !c.suspended && c.state === 2 && c.due <= today;
      if (t.value === 'suspended') return !!c.suspended;
      return false;
    default: return r.text.includes(normalize(t.key ? `${t.key}:${t.value}` : t.value));
  }
}

function search() {
  const today = dayNumber(Date.now(), state.settings);
  const terms = parseQuery($('#br-search').value.trim());
  const deck = $('#br-deck').value;
  const st = $('#br-state').value;
  br.results = br.rows.filter((r) => {
    if (deck && !matchName(r.deck, deck.toLowerCase())) return false;
    if (st && !matches(r, { key: 'is', value: st }, today)) return false;
    return terms.every((t) => matches(r, t, today) !== t.neg);
  });
  br.results.sort((x, y) => x.q.localeCompare(y.q, 'fr', { numeric: true }) || x.card.ord - y.card.ord);
  br.shown = PAGE;
  for (const id of [...br.selected]) if (!br.results.some((r) => r.card.id === id)) br.selected.delete(id);
  render();
}

function status(c, today) {
  if (c.suspended) return ['Suspendue', 'chip-muted'];
  if (c.state === 0) return ['Nouvelle', 'chip-new'];
  if (c.state === 1 || c.state === 3) return ['Apprentissage', 'chip-learn'];
  if (c.due <= today) return ['À revoir', 'chip-review'];
  return [`Dans ${formatInterval({ days: c.due - today })}`, 'chip-muted'];
}

function render() {
  const today = dayNumber(Date.now(), state.settings);
  const list = br.results.slice(0, br.shown);
  $('#br-count').textContent = plural(br.results.length, 'carte');
  $('#br-list').innerHTML = list.length ? list.map((r) => {
    const [label, cls] = status(r.card, today);
    return `<div class="br-row" data-id="${r.card.id}">
      <input type="checkbox" class="br-check" aria-label="Sélectionner"${br.selected.has(r.card.id) ? ' checked' : ''}>
      <div class="br-main">
        <div class="br-q">${escapeHtml(r.q.slice(0, 140)) || '<span class="muted">(vide)</span>'}</div>
        <div class="br-a muted">${escapeHtml(r.a.slice(0, 140))}</div>
      </div>
      <div class="br-meta"><span class="chip ${cls}">${label}</span><small class="muted">${escapeHtml(r.deck.split('::').pop())}</small></div>
    </div>`;
  }).join('') : '<p class="muted center">Aucune carte ne correspond.</p>';
  $('#br-more').hidden = br.results.length <= br.shown;
  updateSelection();
}

function updateSelection() {
  const n = br.selected.size;
  $('#br-selcount').textContent = n ? `${n} sélectionnée${n > 1 ? 's' : ''}` : 'Tout sélectionner';
  $('#br-all').checked = n > 0 && n === br.results.length;
  for (const b of $$('[data-bulk]')) b.disabled = n === 0;
}

async function chooseDeck() {
  const decks = (await db.getAll('decks')).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  const dlg = $('#move-dialog');
  const sel = $('#move-deck');
  sel.innerHTML = '';
  for (const d of decks) sel.add(new Option(d.name.split('::').join(' › '), d.id));
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? Number(sel.value) : null), { once: true });
  });
}

async function bulk(action) {
  const ids = [...br.selected];
  if (!ids.length) return;
  const cards = br.rows.filter((r) => br.selected.has(r.card.id)).map((r) => r.card);
  if (action === 'delete') {
    if (!confirm(`Supprimer ${plural(ids.length, 'carte')} ? Cette action est définitive.`)) return;
    await col.deleteCards(ids);
    toast(`${plural(ids.length, 'carte supprimée', 'cartes supprimées')}.`);
  } else if (action === 'suspend' || action === 'unsuspend') {
    await db.putMany('cards', cards.map((c) => ({ ...c, suspended: action === 'suspend' })));
    toast(action === 'suspend' ? 'Cartes suspendues.' : 'Cartes réactivées.');
  } else if (action === 'reset') {
    if (!confirm(`Remettre ${plural(ids.length, 'carte')} à l’état « nouvelle » ? Leur progression sera perdue.`)) return;
    let pos = 0;
    for (const r of br.rows) if (r.card.state === 0) pos = Math.max(pos, r.card.due);
    await db.putMany('cards', cards.map((c) => resetCard(c, ++pos)));
    toast('Cartes réinitialisées.');
  } else if (action === 'move') {
    const did = await chooseDeck();
    if (!did) return;
    await db.putMany('cards', cards.map((c) => ({ ...c, did })));
    toast('Cartes déplacées.');
  }
  br.selected.clear();
  await reload();
}
