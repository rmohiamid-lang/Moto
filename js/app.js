import * as db from './db.js';
import * as col from './collection.js';
import { renderCard, escapeHtml } from './template.js';
import { buildQueues, pickNext, schedule, answerCard, formatInterval, dayNumber } from './scheduler.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  collapsed: new Set(),
  session: null,
};

// --- Démarrage ---------------------------------------------------------------

async function init() {
  state.settings = await col.loadSettings();
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch { /* stockage indisponible */ }
  applyTheme();
  bindHome();
  bindStudy();
  bindSettings();
  bindDragDrop();
  bindInstall();
  await showHome();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});

  // Ouverture d'un .apkg depuis le système (PWA installée sur ordinateur).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = await Promise.all((params.files || []).map((h) => h.getFile()));
      if (files.length) importFiles(files);
    });
  }
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function isDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// --- Accueil -----------------------------------------------------------------

function bindHome() {
  const input = $('#file-input');
  $('#btn-import').onclick = () => input.click();
  $('#btn-import-empty').onclick = () => input.click();
  input.onchange = () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) importFiles(files);
  };
  $('#btn-sample').onclick = async () => {
    await col.createSampleDeck();
    await showHome();
  };
  $('#deck-list').addEventListener('click', onDeckListClick);
}

async function showHome() {
  state.session = null;
  $('#study').hidden = true;
  $('#home').hidden = false;
  await renderDeckList();
}

async function renderDeckList() {
  const [decks, cards, counts] = await Promise.all([
    db.getAll('decks'), db.getAll('cards'), col.loadDayCounts(state.settings),
  ]);
  state.counts = counts;
  const byDeck = new Map();
  for (const c of cards) {
    if (!byDeck.has(c.did)) byDeck.set(c.did, []);
    byDeck.get(c.did).push(c);
  }
  const tree = col.buildTree(decks);
  state.tree = tree;
  const now = Date.now();
  const rowsHtml = [];
  const walk = (node, depth) => {
    const subCards = node.ids.flatMap((id) => byDeck.get(id) || []);
    const q = buildQueues(subCards, now, state.settings, limitsFor(node.ids));
    const num = (n, cls) => `<span class="num ${n ? cls : 'zero'}">${n}</span>`;
    const hasKids = node.children.length > 0;
    const collapsed = state.collapsed.has(node.fullName);
    rowsHtml.push(`
      <div class="deck-row" data-name="${escapeHtml(node.fullName)}">
        <div class="deck-name-cell" style="padding-left:${depth * 18}px">
          ${hasKids ? `<button class="toggle" data-action="toggle" aria-label="${collapsed ? 'Déplier' : 'Replier'}">${collapsed ? '▶' : '▼'}</button>` : '<span class="toggle"></span>'}
          <button class="deck-link" data-action="study">${escapeHtml(node.name)}</button>
        </div>
        ${num(q.fresh.length, 'c-new')}${num(q.learnToday.length, 'c-learn')}${num(q.review.length, 'c-review')}
        <button class="menu-btn" data-action="menu" aria-label="Options du paquet">⋮</button>
      </div>`);
    if (!collapsed) for (const child of node.children) walk(child, depth + 1);
  };
  for (const child of tree.children) walk(child, 0);

  $('#empty').hidden = decks.length > 0;
  $('#deck-list').innerHTML = decks.length ? `
    <div class="deck-table">
      <div class="deck-head"><span>Paquet</span><span>Nouv.</span><span>Appr.</span><span>À rev.</span><span></span></div>
      ${rowsHtml.join('')}
    </div>` : '';
  const reps = Object.values(counts.decks).reduce((s, d) => s + (d.reps || 0), 0);
  $('#today-stats').textContent = decks.length
    ? `${cards.length} cartes · ${reps} révision${reps > 1 ? 's' : ''} aujourd’hui` : '';
}

function limitsFor(ids) {
  const s = state.settings, counts = state.counts;
  return {
    fresh: s.newPerDay - col.doneToday(counts, ids, 'fresh'),
    reviews: s.reviewsPerDay - col.doneToday(counts, ids, 'review'),
  };
}

function findNode(fullName, node = state.tree) {
  if (node.fullName === fullName) return node;
  for (const c of node.children) {
    const f = findNode(fullName, c);
    if (f) return f;
  }
  return null;
}

async function onDeckListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const name = btn.closest('.deck-row').dataset.name;
  const node = findNode(name);
  if (!node) return;
  if (btn.dataset.action === 'toggle') {
    if (state.collapsed.has(name)) state.collapsed.delete(name); else state.collapsed.add(name);
    try { localStorage.setItem('collapsed', JSON.stringify([...state.collapsed])); } catch { /* ignoré */ }
    renderDeckList();
  } else if (btn.dataset.action === 'study') {
    startStudy(node);
  } else if (btn.dataset.action === 'menu') {
    openMenu(btn, [
      ['Étudier', () => startStudy(node)],
      ['Renommer', () => renameDeck(node)],
      ['Supprimer', () => deleteDeck(node), 'danger'],
    ]);
  }
}

function openMenu(anchor, items) {
  document.querySelector('.popup-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { menu.remove(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', function close(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
  }), 0);
}

async function renameDeck(node) {
  const newName = prompt('Nouveau nom du paquet (utilisez « :: » pour les sous-paquets) :', node.fullName);
  if (!newName || !newName.trim() || newName.trim() === node.fullName) return;
  const target = newName.trim().replace(/\s*::\s*/g, '::');
  const decks = await db.getAll('decks');
  if (decks.some((d) => d.name === target)) { toast('Un paquet porte déjà ce nom.'); return; }
  const updated = decks
    .filter((d) => d.name === node.fullName || d.name.startsWith(`${node.fullName}::`))
    .map((d) => ({ ...d, name: target + d.name.slice(node.fullName.length) }));
  await db.putMany('decks', updated);
  renderDeckList();
}

async function deleteDeck(node) {
  const cards = (await db.getAll('cards')).filter((c) => node.ids.includes(c.did)).length;
  if (!confirm(`Supprimer « ${node.fullName} » et ses ${cards} carte${cards > 1 ? 's' : ''} ? Cette action est définitive.`)) return;
  await col.deleteDecks(node.ids);
  toast('Paquet supprimé.');
  renderDeckList();
}

// --- Import ------------------------------------------------------------------

async function importFiles(files) {
  const dlg = $('#progress-dialog');
  dlg.showModal();
  const progress = (text, ratio) => {
    $('#progress-text').textContent = text;
    $('#progress-bar').value = Math.min(1, ratio);
  };
  try {
    for (const file of files) {
      progress(`Ouverture de ${file.name}…`, 0);
      const r = await col.importPackage(file, state.settings, progress);
      const extra = r.skipped ? ` (${r.skipped} déjà présentes)` : '';
      toast(`${file.name} : ${r.cards} carte${r.cards > 1 ? 's' : ''} importée${r.cards > 1 ? 's' : ''}${extra}, ${r.media} média${r.media > 1 ? 's' : ''}.`, 5000);
    }
  } catch (err) {
    console.error(err);
    toast(`Échec de l’import : ${err.message || err}`, 7000);
  } finally {
    dlg.close();
    if (!state.session) renderDeckList();
  }
}

function bindDragDrop() {
  const hint = $('#drop-hint');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; hint.hidden = false; } });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hint.hidden = true; } });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    const files = [...e.dataTransfer.files].filter((f) => /\.(apkg|colpkg|zip)$/i.test(f.name));
    if (files.length) importFiles(files); else toast('Seuls les fichiers .apkg et .colpkg sont acceptés.');
  });
}

function bindInstall() {
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#btn-install').hidden = true;
  };
}

// --- Révision ----------------------------------------------------------------

const BASE_CARD_CSS = `
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 20px 16px 40px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 20px; line-height: 1.45; text-align: center; overflow-wrap: anywhere; }
img, video { max-width: 100%; height: auto; }
hr#answer { margin: 20px 0; border: none; border-top: 1px solid #8884; }
.cloze { font-weight: bold; color: blue; }
.replay-button { font-size: 0.8em; width: 2em; height: 2em; border-radius: 50%; border: 1px solid #8886;
  background: transparent; color: inherit; cursor: pointer; vertical-align: middle; margin: 0 4px; }
#typeans { font: inherit; width: 90%; max-width: 420px; padding: 6px 10px; border-radius: 8px; border: 1px solid #8888; }
div#typeans { border: none; font-family: ui-monospace, monospace; }
.typeGood { background: #b8f5c0; color: #0a3d12; }
.typeBad { background: #ffc4c4; color: #5c0b0b; }
.typeMissed { background: #e0e0e0; color: #333; }
details.hint summary { cursor: pointer; color: #2563eb; font-size: 0.85em; }
`;

const DARK_CARD_CSS = `
html, body.card { background-color: #1f2226 !important; color: #e8eaed !important; }
.nightMode .cloze, .night_mode .cloze { color: #7cb4ff; }
a { color: #7cb4ff; }
`;

// Script injecté dans la carte (iframe isolée) : clavier, saisie et sons.
const BRIDGE = `
(() => {
  const post = (m) => parent.postMessage(m, '*');
  document.addEventListener('keydown', (e) => {
    const typing = e.target && e.target.id === 'typeans';
    if (typing && e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing) e.preventDefault();
    if (e.key === ' ') e.preventDefault();
    post({ type: 'key', key: e.key });
  });
  const input = document.getElementById('typeans');
  if (input && input.tagName === 'INPUT') {
    input.addEventListener('input', () => post({ type: 'typed', value: input.value }));
    setTimeout(() => input.focus(), 30);
  }
  const audio = new Audio();
  let queue = [];
  const playNext = () => { const b = queue.shift(); if (b) { audio.src = b.dataset.src; audio.play().catch(() => {}); } };
  audio.addEventListener('ended', playNext);
  const playAll = (auto) => {
    queue = [...document.querySelectorAll('.replay-button')].filter((b) => !auto || b.hasAttribute('data-autoplay'));
    if (!auto && !queue.length) return;
    audio.pause(); playNext();
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.replay-button');
    if (b) { queue = []; audio.src = b.dataset.src; audio.play().catch(() => {}); }
  });
  addEventListener('message', (e) => { if (e.data === 'replay') playAll(false); });
  playAll(true);
  const ans = document.getElementById('answer');
  if (ans && document.body.dataset.side === 'a') ans.scrollIntoView({ block: 'start' });
})();
`;

async function cardDocument(html, notetype, card, side) {
  const dark = isDark();
  const [body, css] = await Promise.all([col.inlineMedia(html), col.inlineMedia(notetype.css || '')]);
  const cls = `card card${card.ord + 1}${dark ? ' nightMode night_mode' : ''}`;
  return `<!doctype html><html class="${dark ? 'night-mode' : ''}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">
<style>${BASE_CARD_CSS}</style><style>${css}</style>${dark ? `<style>${DARK_CARD_CSS}</style>` : ''}
</head><body class="${cls}" data-side="${side}"><div id="qa">${body}</div>
<script>${BRIDGE}<\/script></body></html>`;
}

function bindStudy() {
  $('#btn-back').onclick = () => showHome();
  $('#btn-done-back').onclick = () => showHome();
  $('#btn-show').onclick = () => reveal();
  $('#btn-undo').onclick = () => undo();
  $('#btn-suspend').onclick = () => suspendCurrent();
  for (const b of document.querySelectorAll('[data-rating]')) {
    b.onclick = () => answer(Number(b.dataset.rating));
  }
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, dialog')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.session && handleStudyKey(e.key)) e.preventDefault();
  });
  addEventListener('message', (e) => {
    if (!state.session || e.source !== $('#card-frame').contentWindow) return;
    const m = e.data || {};
    if (m.type === 'key') handleStudyKey(m.key);
    else if (m.type === 'typed') state.session.typed = String(m.value);
  });
}

function handleStudyKey(key) {
  const s = state.session;
  if (key === 'Escape') { showHome(); return true; }
  if (!s.current) return false;
  if (!s.revealed) {
    if (key === ' ' || key === 'Enter') { reveal(); return true; }
  } else {
    if (key === ' ' || key === 'Enter') { answer(3); return true; }
    if (['1', '2', '3', '4'].includes(key)) { answer(Number(key)); return true; }
  }
  if (key === 'r' || key === 'R' || key === 'F5') { $('#card-frame').contentWindow?.postMessage('replay', '*'); return true; }
  if (key === 'u' || key === 'U') { undo(); return true; }
  if (key === 's' || key === 'S') { suspendCurrent(); return true; }
  return false;
}

async function startStudy(node) {
  const [cards, notetypes, decks] = await Promise.all([
    db.getAll('cards'), db.getAll('notetypes'), db.getAll('decks'),
  ]);
  const ids = new Set(node.ids);
  state.counts = await col.loadDayCounts(state.settings);
  state.session = {
    node,
    cards: cards.filter((c) => ids.has(c.did)),
    notetypes: new Map(notetypes.map((n) => [n.id, n])),
    deckNames: new Map(decks.map((d) => [d.id, d.name])),
    notes: new Map(),
    shown: { fresh: 0, review: 0 },
    undo: [],
    current: null,
  };
  $('#home').hidden = true;
  $('#study').hidden = false;
  $('#study-deck').textContent = node.fullName;
  $('#btn-undo').disabled = true;
  await nextCard();
}

function sessionQueues() {
  const s = state.session;
  return buildQueues(s.cards, Date.now(), state.settings, limitsFor(s.node.ids));
}

let waitTimer;
async function nextCard() {
  const s = state.session;
  if (!s) return;
  clearTimeout(waitTimer);
  const now = Date.now();
  // Une nouvelle journée a commencé pendant la session : on repart à zéro.
  if (state.counts.day !== dayNumber(now, state.settings)) state.counts = await col.loadDayCounts(state.settings);
  const q = sessionQueues();
  const card = pickNext(q, now, state.settings, s.shown);
  updateCounts(q, card);
  s.current = card;
  s.revealed = false;
  s.typed = '';
  if (!card) {
    showDone(q);
    return;
  }
  $('#done').hidden = true;
  $('#card-frame').hidden = false;
  let note = s.notes.get(card.nid);
  if (!note) {
    note = await db.get('notes', card.nid);
    s.notes.set(card.nid, note);
  }
  const notetype = note && s.notetypes.get(note.mid);
  if (!notetype) {
    s.rendered = { question: '<p>Note introuvable pour cette carte.</p>', answer: '' };
  } else {
    s.rendered = renderCard({ notetype, note, card, deckName: s.deckNames.get(card.did) || '' });
  }
  s.notetype = notetype || { css: '', fields: [], templates: [] };
  s.note = note;
  s.shownAt = Date.now();
  if (s.current !== card) return;
  $('#card-frame').srcdoc = await cardDocument(s.rendered.question, s.notetype, card, 'q');
  $('#btn-show').hidden = false;
  $('#ratings').hidden = true;
  $('#btn-show').focus({ preventScroll: true });
}

function updateCounts(q, card) {
  const set = (id, n, active) => {
    const el = $(id);
    el.textContent = n;
    el.classList.toggle('current', active);
  };
  set('#cnt-new', q.fresh.length, !!card && card.state === 0);
  set('#cnt-learn', q.learnToday.length, !!card && (card.state === 1 || card.state === 3));
  set('#cnt-review', q.review.length, !!card && card.state === 2);
}

function showDone(q) {
  $('#card-frame').hidden = true;
  $('#card-frame').srcdoc = '';
  $('#btn-show').hidden = true;
  $('#ratings').hidden = true;
  $('#done').hidden = false;
  const later = q.learn.filter((c) => !c.suspended);
  if (later.length) {
    const next = Math.min(...later.map((c) => c.due));
    const mins = Math.max(1, Math.ceil((next - Date.now()) / 60000));
    $('#done-text').textContent = `${later.length} carte${later.length > 1 ? 's' : ''} en apprentissage reviendr${later.length > 1 ? 'ont' : 'a'} dans ${formatInterval({ delayMs: mins * 60000 })}.`;
    waitTimer = setTimeout(() => nextCard(), Math.min(next - Date.now() - state.settings.learnAheadMin * 60000 + 500, 2 ** 31 - 1));
  } else {
    $('#done-text').textContent = 'Vous avez terminé ce paquet pour aujourd’hui. Revenez demain !';
  }
}

async function reveal() {
  const s = state.session;
  if (!s?.current || s.revealed) return;
  s.revealed = true;
  const card = s.current;
  if (s.rendered.expectsTyping && s.notetype.templates.length) {
    s.rendered = renderCard({
      notetype: s.notetype, note: s.note, card, deckName: s.deckNames.get(card.did) || '', typed: s.typed,
    });
  }
  const now = Date.now();
  for (const r of [1, 2, 3, 4]) {
    document.querySelector(`[data-ivl="${r}"]`).textContent = formatInterval(schedule(card, r, now, state.settings));
  }
  $('#btn-show').hidden = true;
  $('#ratings').hidden = false;
  $('#card-frame').srcdoc = await cardDocument(s.rendered.answer, s.notetype, card, 'a');
}

async function answer(rating) {
  const s = state.session;
  if (!s?.current || !s.revealed) return;
  const before = s.current;
  s.current = null;
  const now = Date.now();
  const after = answerCard(before, rating, now, state.settings);
  const kind = before.state === 0 ? 'fresh' : before.state === 2 ? 'review' : null;
  if (kind) {
    s.shown[kind]++;
    await col.bumpDayCount(state.counts, before.did, kind);
  }
  await col.bumpDayCount(state.counts, before.did, 'reps');
  replaceCard(after);
  const log = { id: now, cid: before.id, rating, state: before.state, ivl: after.ivl, ease: after.ease, time: now - s.shownAt };
  await Promise.all([db.put('cards', after), db.put('revlog', log)]);
  s.undo.push({ before, kind, logId: log.id });
  if (s.undo.length > 30) s.undo.shift();
  $('#btn-undo').disabled = false;
  await nextCard();
}

function replaceCard(card) {
  const s = state.session;
  const i = s.cards.findIndex((c) => c.id === card.id);
  if (i >= 0) s.cards[i] = card;
}

async function undo() {
  const s = state.session;
  const last = s?.undo.pop();
  if (!last) return;
  if (last.kind) {
    s.shown[last.kind]--;
    await col.bumpDayCount(state.counts, last.before.did, last.kind, -1);
  }
  if (last.logId) {
    await col.bumpDayCount(state.counts, last.before.did, 'reps', -1);
    await db.del('revlog', last.logId);
  }
  replaceCard(last.before);
  await db.put('cards', last.before);
  $('#btn-undo').disabled = s.undo.length === 0;
  // Réaffiche directement la carte annulée.
  const card = last.before;
  s.current = card;
  s.revealed = false;
  s.typed = '';
  const note = s.notes.get(card.nid) || await db.get('notes', card.nid);
  const notetype = note && s.notetypes.get(note.mid);
  s.note = note;
  s.notetype = notetype || { css: '', fields: [], templates: [] };
  s.rendered = notetype
    ? renderCard({ notetype, note, card, deckName: s.deckNames.get(card.did) || '' })
    : { question: '<p>Note introuvable.</p>', answer: '' };
  s.shownAt = Date.now();
  updateCounts(sessionQueues(), card);
  $('#done').hidden = true;
  $('#card-frame').hidden = false;
  $('#card-frame').srcdoc = await cardDocument(s.rendered.question, s.notetype, card, 'q');
  $('#btn-show').hidden = false;
  $('#ratings').hidden = true;
  toast('Dernière réponse annulée.');
}

async function suspendCurrent() {
  const s = state.session;
  if (!s?.current) return;
  const before = s.current;
  const after = { ...before, suspended: true };
  replaceCard(after);
  await db.put('cards', after);
  s.undo.push({ before, kind: null, logId: null });
  $('#btn-undo').disabled = false;
  toast('Carte suspendue.');
  await nextCard();
}

// --- Réglages ----------------------------------------------------------------

function bindSettings() {
  const dlg = $('#settings-dialog');
  const form = $('#settings-form');
  $('#btn-settings').onclick = async () => {
    const s = state.settings;
    form.newPerDay.value = s.newPerDay;
    form.reviewsPerDay.value = s.reviewsPerDay;
    form.learnSteps.value = s.learnSteps.join(' ');
    form.relearnSteps.value = s.relearnSteps.join(' ');
    form.graduatingIvl.value = s.graduatingIvl;
    form.easyIvl.value = s.easyIvl;
    form.dayStartHour.value = s.dayStartHour;
    form.theme.value = s.theme;
    $('#storage-info').textContent = '';
    dlg.showModal();
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est?.usage != null) {
      $('#storage-info').textContent = `Espace utilisé sur l’appareil : ${(est.usage / 1048576).toFixed(1)} Mo.`;
    }
  };
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const steps = (v) => v.split(/[\s,;]+/).map((x) => parseFloat(x.replace(',', '.'))).filter((x) => x > 0);
    state.settings = {
      ...state.settings,
      newPerDay: Number(form.newPerDay.value),
      reviewsPerDay: Number(form.reviewsPerDay.value),
      learnSteps: steps(form.learnSteps.value),
      relearnSteps: steps(form.relearnSteps.value),
      graduatingIvl: Number(form.graduatingIvl.value),
      easyIvl: Number(form.easyIvl.value),
      dayStartHour: Number(form.dayStartHour.value),
      theme: form.theme.value,
    };
    await col.saveSettings(state.settings);
    applyTheme();
    renderDeckList();
    toast('Réglages enregistrés.');
  });
  $('#btn-wipe').onclick = async () => {
    if (!confirm('Effacer tous les paquets, cartes, médias et la progression ? Cette action est définitive.')) return;
    await db.clearAll();
    state.settings = await col.loadSettings();
    applyTheme();
    dlg.close();
    renderDeckList();
    toast('Toutes les données ont été effacées.');
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto' && state.session?.current) {
      const s = state.session;
      cardDocument(s.revealed ? s.rendered.answer : s.rendered.question, s.notetype, s.current, s.revealed ? 'a' : 'q')
        .then((doc) => { $('#card-frame').srcdoc = doc; });
    }
  });
}

init();
