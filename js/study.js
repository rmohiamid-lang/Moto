// Écran de révision : session normale ou personnalisée, gestes, voix, annulation.
import * as db from './db.js';
import * as col from './collection.js';
import { renderCard } from './template.js';
import { buildQueues, pickNext, schedule, answerCard, formatInterval, dayNumber } from './scheduler.js';
import { state, makeLimiter, deckSetting } from './state.js';
import { $, $$, toast, showView } from './ui.js';
import { ttsSegments, speak, stopSpeaking, ttsAvailable } from './tts.js';
import { openEditor } from './editor.js';

const MIN = 60 * 1000;

const BASE_CARD_CSS = `
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 20px 16px 40px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 20px; line-height: 1.45; text-align: center; overflow-wrap: anywhere; min-height: 100vh; box-sizing: border-box; }
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

// Script injecté dans la carte (iframe isolée) : clavier, saisie, sons et gestes.
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
  const interactive = 'a, button, input, textarea, select, details, summary, label, audio, video';
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.replay-button');
    if (b) { queue = []; audio.src = b.dataset.src; audio.play().catch(() => {}); return; }
    if (!e.target.closest(interactive)) post({ type: 'tap' });
  });
  if (document.body.dataset.gestures === '1') {
    let start = null;
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, time: Date.now() } : null;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - start.time < 800) {
        post({ type: 'swipe', dir: dx > 0 ? 'right' : 'left' });
      }
      start = null;
    }, { passive: true });
  }
  addEventListener('message', (e) => { if (e.data === 'replay') playAll(false); });
  playAll(true);
  const ans = document.getElementById('answer');
  if (ans && document.body.dataset.side === 'a') ans.scrollIntoView({ block: 'start' });
})();
`;

function isDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

async function cardDocument(html, notetype, card, side) {
  const dark = isDark();
  const [body, css] = await Promise.all([col.inlineMedia(html), col.inlineMedia(notetype.css || '')]);
  const cls = `card card${card.ord + 1}${dark ? ' nightMode night_mode' : ''}`;
  const gestures = state.settings.gestures ? '1' : '0';
  return `<!doctype html><html class="${dark ? 'night-mode' : ''}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">
<style>${BASE_CARD_CSS}</style><style>${css}</style>${dark ? `<style>${DARK_CARD_CSS}</style>` : ''}
</head><body class="${cls}" data-side="${side}" data-gestures="${gestures}"><div id="qa">${body}</div>
<script>${BRIDGE}<\/script></body></html>`;
}

// --- Liaison des contrôles ---------------------------------------------------------

export function bindStudy() {
  $('#btn-back').onclick = () => exitStudy();
  $('#btn-done-back').onclick = () => exitStudy();
  $('#btn-show').onclick = () => reveal();
  $('#btn-undo').onclick = () => undo();
  $('#btn-suspend').onclick = () => suspendCurrent();
  $('#btn-edit').onclick = () => editCurrent();
  $('#btn-speak').onclick = () => speakCurrent();
  $('#btn-speak').hidden = !ttsAvailable();
  for (const b of $$('[data-rating]')) b.onclick = () => answer(Number(b.dataset.rating));
  addEventListener('keydown', (e) => {
    if ($('#study').hidden || e.target.closest?.('input, textarea, select, dialog, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.session && handleKey(e.key)) e.preventDefault();
  });
  addEventListener('message', (e) => {
    if (!state.session || e.source !== $('#card-frame').contentWindow) return;
    const m = e.data || {};
    if (m.type === 'key') handleKey(m.key);
    else if (m.type === 'typed') state.session.typed = String(m.value);
    else if (m.type === 'tap' && state.settings.gestures && !state.session.revealed) reveal();
    else if (m.type === 'swipe' && state.settings.gestures) onSwipe(m.dir);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto' && state.session?.current) redraw();
  });
}

function handleKey(key) {
  const s = state.session;
  if (key === 'Escape') { exitStudy(); return true; }
  if (!s.current) return false;
  if (!s.revealed) {
    if (key === ' ' || key === 'Enter') { reveal(); return true; }
  } else {
    if (key === ' ' || key === 'Enter') { answer(3); return true; }
    if (['1', '2', '3', '4'].includes(key)) { answer(Number(key)); return true; }
  }
  const k = key.toLowerCase();
  if (k === 'r' || key === 'F5') { $('#card-frame').contentWindow?.postMessage('replay', '*'); return true; }
  if (k === 'u') { undo(); return true; }
  if (k === 's') { suspendCurrent(); return true; }
  if (k === 'e') { editCurrent(); return true; }
  if (k === 't') { speakCurrent(); return true; }
  return false;
}

function onSwipe(dir) {
  const s = state.session;
  if (!s?.current) return;
  if (!s.revealed) { reveal(); return; }
  const rating = dir === 'left' ? 1 : 3;
  const flash = $('#swipe-flash');
  flash.textContent = rating === 1 ? '← À revoir' : 'Correct →';
  flash.className = `swipe-flash ${rating === 1 ? 'again' : 'good'}`;
  flash.hidden = false;
  setTimeout(() => { flash.hidden = true; }, 450);
  answer(rating);
}

function exitStudy() {
  stopSpeaking();
  clearTimeout(waitTimer);
  state.session = null;
  state.goHome();
}

// --- Démarrage d'une session ------------------------------------------------------

async function baseSession(node, cards, title) {
  const [notetypes, decks] = await Promise.all([db.getAll('notetypes'), db.getAll('decks')]);
  state.counts = await col.loadDayCounts(state.settings);
  return {
    node,
    title,
    cards,
    notetypes: new Map(notetypes.map((n) => [n.id, n])),
    decks: new Map(decks.map((d) => [d.id, d])),
    notes: new Map(),
    shown: { fresh: 0, review: 0 },
    undo: [],
    current: null,
  };
}

function open(session) {
  state.session = session;
  showView('study');
  $('#study-deck').textContent = session.title;
  $('#btn-undo').disabled = true;
  return nextCard();
}

export async function startStudy(node) {
  const ids = new Set(node.ids);
  const cards = (await db.getAll('cards')).filter((c) => ids.has(c.did));
  return open(await baseSession(node, cards, node.fullName));
}

// Session personnalisée : une liste fixe de cartes, replanifiées normalement.
export async function startCustom(node, cards, title) {
  const s = await baseSession(node, cards, title);
  s.custom = true;
  s.queue = cards.map((c) => c.id);
  return open(s);
}

// --- Choix et affichage des cartes ------------------------------------------------

function queues() {
  const s = state.session;
  const now = Date.now();
  if (s.custom) {
    const byId = new Map(s.cards.map((c) => [c.id, c]));
    const list = s.queue.map((id) => byId.get(id)).filter((c) => c && !c.suspended);
    const isLearn = (c) => c.state === 1 || c.state === 3;
    return {
      custom: true,
      list,
      fresh: list.filter((c) => c.state === 0),
      learnToday: list.filter(isLearn),
      learn: list.filter(isLearn),
      review: list.filter((c) => c.state === 2),
      next: list.find((c) => !isLearn(c) || c.due <= now + state.settings.learnAheadMin * MIN) || null,
    };
  }
  return buildQueues(s.cards, now, state.settings, makeLimiter(s.node));
}

let waitTimer;
async function nextCard() {
  const s = state.session;
  if (!s) return;
  clearTimeout(waitTimer);
  stopSpeaking();
  const now = Date.now();
  // Une nouvelle journée a commencé pendant la session : on repart à zéro.
  if (state.counts.day !== dayNumber(now, state.settings)) state.counts = await col.loadDayCounts(state.settings);
  const q = queues();
  const card = q.custom ? q.next : pickNext(q, now, state.settings, s.shown);
  updateCounts(q, card);
  s.current = card;
  s.revealed = false;
  s.typed = '';
  if (!card) {
    showDone(q);
    return;
  }
  await prepare(card);
  if (s.current !== card) return;
  await showSide('q');
}

async function prepare(card) {
  const s = state.session;
  let note = s.notes.get(card.nid);
  if (!note) {
    note = await db.get('notes', card.nid);
    s.notes.set(card.nid, note);
  }
  const notetype = note && s.notetypes.get(note.mid);
  s.note = note;
  s.notetype = notetype || { css: '', fields: [], templates: [] };
  s.rendered = notetype
    ? renderCard({ notetype, note, card, deckName: s.decks.get(card.did)?.name || '' })
    : { question: '<p>Note introuvable pour cette carte.</p>', answer: '' };
  s.shownAt = Date.now();
}

async function showSide(side) {
  const s = state.session;
  $('#done').hidden = true;
  $('#card-frame').hidden = false;
  $('#btn-show').hidden = side === 'a';
  $('#ratings').hidden = side !== 'a';
  $('#card-frame').srcdoc = await cardDocument(side === 'a' ? s.rendered.answer : s.rendered.question, s.notetype, s.current, side);
  if (side === 'q') $('#btn-show').focus({ preventScroll: true });
  if (state.settings.autoTts) speakCurrent();
}

function redraw() {
  const s = state.session;
  if (s?.current) showSide(s.revealed ? 'a' : 'q');
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
    const mins = Math.max(1, Math.ceil((next - Date.now()) / MIN));
    $('#done-text').textContent = `${later.length} carte${later.length > 1 ? 's' : ''} en apprentissage reviendr${later.length > 1 ? 'ont' : 'a'} dans ${formatInterval({ delayMs: mins * MIN })}.`;
    waitTimer = setTimeout(() => nextCard(), Math.min(next - Date.now() - state.settings.learnAheadMin * MIN + 500, 2 ** 31 - 1));
  } else if (state.session.custom) {
    $('#done-text').textContent = 'Vous avez terminé cette révision personnalisée.';
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
      notetype: s.notetype, note: s.note, card, deckName: s.decks.get(card.did)?.name || '', typed: s.typed,
    });
  }
  const now = Date.now();
  for (const r of [1, 2, 3, 4]) {
    $(`[data-ivl="${r}"]`).textContent = formatInterval(schedule(card, r, now, state.settings));
  }
  await showSide('a');
}

// --- Réponses ----------------------------------------------------------------------

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
  const prevQueue = s.custom ? [...s.queue] : null;
  if (s.custom) {
    s.queue = s.queue.filter((id) => id !== before.id);
    if (after.state === 1 || after.state === 3) s.queue.push(after.id);
  }
  const log = {
    id: now, cid: before.id, rating, state: before.state, ivl: after.ivl, ease: after.ease,
    time: Math.min(now - s.shownAt, 60000),
  };
  await Promise.all([db.put('cards', after), db.put('revlog', log)]);
  s.undo.push({ before, kind, logId: log.id, queue: prevQueue });
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
  if (last.queue) s.queue = last.queue;
  replaceCard(last.before);
  await db.put('cards', last.before);
  $('#btn-undo').disabled = s.undo.length === 0;
  // Réaffiche directement la carte annulée.
  const card = last.before;
  s.current = card;
  s.revealed = false;
  s.typed = '';
  await prepare(card);
  updateCounts(queues(), card);
  await showSide('q');
  toast('Dernière action annulée.');
}

async function suspendCurrent() {
  const s = state.session;
  if (!s?.current) return;
  const before = s.current;
  const after = { ...before, suspended: true };
  replaceCard(after);
  await db.put('cards', after);
  s.undo.push({ before, kind: null, logId: null, queue: null });
  $('#btn-undo').disabled = false;
  toast('Carte suspendue.');
  await nextCard();
}

function speakCurrent() {
  const s = state.session;
  if (!s?.current) return;
  const deck = s.decks.get(s.current.did);
  const lang = deckSetting(deck, 'ttsLang');
  speak(ttsSegments(s.revealed ? s.rendered.answer : s.rendered.question, s.revealed ? 'a' : 'q', lang));
}

function editCurrent() {
  const s = state.session;
  if (!s?.current) return;
  stopSpeaking();
  const card = s.current;
  openEditor({
    noteId: card.nid,
    onClose: async ({ deleted } = {}) => {
      showView('study');
      if (!state.session) return;
      s.notes.delete(card.nid);
      const fresh = await db.getAllByIndex('cards', 'nid', card.nid);
      s.cards = s.cards.filter((c) => c.nid !== card.nid);
      if (!deleted) {
        // Les cartes de la note restent dans la session si elles sont toujours dans ses paquets.
        const ids = new Set(s.node.ids);
        s.cards.push(...fresh.filter((c) => ids.has(c.did)));
      } else if (s.queue) {
        s.queue = s.queue.filter((id) => s.cards.some((c) => c.id === id));
      }
      const still = s.cards.find((c) => c.id === card.id);
      if (!still) { await nextCard(); return; }
      s.current = still;
      await prepare(still);
      if (s.revealed) {
        s.revealed = false;
        await reveal();
      } else {
        await showSide('q');
      }
    },
  });
}
