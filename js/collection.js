// Logique de la collection : import, arborescence des paquets, compteurs du jour, médias.
import * as db from './db.js';
import { parsePackage } from './apkg.js';
import { DEFAULT_SETTINGS, dayNumber } from './scheduler.js';
import { renderCard, clozeOrdinals } from './template.js';

export async function loadSettings() {
  const saved = await db.get('kv', 'settings');
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function saveSettings(settings) {
  await db.put('kv', settings, 'settings');
}

// --- Import -------------------------------------------------------------------

export async function importPackage(file, settings, onProgress = () => {}) {
  onProgress('Lecture du fichier…', 0);
  const pkg = await parsePackage(file);
  onProgress('Enregistrement des cartes…', 0.2);

  const existingDecks = await db.getAll('decks');
  const byName = new Map(existingDecks.map((d) => [d.name, d]));
  const usedIds = new Set(existingDecks.map((d) => d.id));
  const newDecks = [];
  const ensureDeck = (name, preferredId) => {
    if (byName.has(name)) return byName.get(name).id;
    let id = preferredId && !usedIds.has(preferredId) ? preferredId : Date.now() + usedIds.size;
    while (usedIds.has(id)) id++;
    const deck = { id, name };
    usedIds.add(id);
    byName.set(name, deck);
    newDecks.push(deck);
    return id;
  };
  const deckMap = new Map();
  for (const d of [...pkg.decks].sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = d.name.split('::');
    for (let i = 1; i < parts.length; i++) ensureDeck(parts.slice(0, i).join('::'));
    deckMap.set(d.id, ensureDeck(d.name, d.id));
  }
  const fallbackDeck = () => ensureDeck('Importé');

  const existingCardIds = new Set(await db.getAllKeys('cards'));
  let maxNewPos = 0;
  for (const c of await db.getAll('cards')) if (c.state === 0) maxNewPos = Math.max(maxNewPos, c.due);

  const cards = [];
  let skipped = 0;
  for (const c of pkg.cards) {
    if (existingCardIds.has(c.id)) { skipped++; continue; }
    const card = { ...c, did: deckMap.get(c.did) ?? fallbackDeck() };
    if (card.state === 2) card.due = dayNumber(card.dueTs, settings);
    else card.due = ++maxNewPos;
    delete card.dueTs;
    cards.push(card);
  }

  await db.putMany('decks', newDecks);
  await db.putMany('notetypes', pkg.notetypes);
  await db.putMany('notes', pkg.notes);
  await db.putMany('cards', cards);

  const total = pkg.media.length;
  for (let i = 0; i < total; i += 50) {
    const batch = pkg.media.slice(i, i + 50);
    const records = await Promise.all(batch.map(async (m) => mediaRecord(m.name, await pkg.loadMedia(m))));
    await db.putMany('media', records);
    onProgress(`Import des médias (${Math.min(i + 50, total)}/${total})…`, 0.3 + 0.7 * ((i + 50) / total));
  }
  mediaCache.clear();
  return { cards: cards.length, skipped, notes: pkg.notes.length, media: total };
}

// --- Arborescence des paquets -------------------------------------------------

export function buildTree(decks) {
  const root = { name: '', fullName: '', children: [], ids: [] };
  const nodes = new Map([['', root]]);
  const ensure = (fullName) => {
    if (nodes.has(fullName)) return nodes.get(fullName);
    const i = fullName.lastIndexOf('::');
    const parent = ensure(i < 0 ? '' : fullName.slice(0, i));
    const node = { name: fullName.slice(i < 0 ? 0 : i + 2), fullName, children: [], ids: [], deck: null };
    parent.children.push(node);
    nodes.set(fullName, node);
    return node;
  };
  for (const d of decks) ensure(d.name).deck = d;
  const collect = (n) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    n.ids = [...(n.deck ? [n.deck.id] : []), ...n.children.flatMap(collect)];
    return n.ids;
  };
  collect(root);
  return root;
}

export async function deleteDecks(deckIds) {
  const ids = new Set(deckIds);
  await deleteCards((await db.getAll('cards')).filter((c) => ids.has(c.did)).map((c) => c.id));
  await db.deleteMany('decks', deckIds);
}

// Supprime des cartes, et les notes qui n'ont plus aucune carte.
export async function deleteCards(cardIds) {
  const ids = new Set(cardIds);
  const all = await db.getAll('cards');
  const nids = new Set(all.filter((c) => ids.has(c.id)).map((c) => c.nid));
  await db.deleteMany('cards', cardIds);
  const remaining = new Set(all.filter((c) => !ids.has(c.id)).map((c) => c.nid));
  await db.deleteMany('notes', [...nids].filter((nid) => !remaining.has(nid)));
}

// Renvoie l'id du paquet portant ce nom, en le créant (avec ses parents) au besoin.
export async function ensureDeck(name) {
  const decks = await db.getAll('decks');
  const parts = name.split('::');
  let id = null;
  for (let i = 1; i <= parts.length; i++) {
    const n = parts.slice(0, i).join('::');
    let d = decks.find((x) => x.name === n);
    if (!d) {
      d = { id: newId(), name: n };
      decks.push(d);
      await db.put('decks', d);
    }
    id = d.id;
  }
  return id;
}

// --- Compteurs du jour --------------------------------------------------------

export async function loadDayCounts(settings) {
  const today = dayNumber(Date.now(), settings);
  const saved = await db.get('kv', 'dayCounts');
  return saved && saved.day === today ? saved : { day: today, decks: {}, extra: {} };
}

// Révision personnalisée : augmente la limite du jour d'un paquet.
export async function addExtraLimit(counts, deckName, kind, n) {
  counts.extra ??= {};
  const e = (counts.extra[deckName] ??= { fresh: 0, review: 0 });
  e[kind] += n;
  await db.put('kv', counts, 'dayCounts');
}

export async function bumpDayCount(counts, did, kind, delta = 1) {
  const c = (counts.decks[did] ??= { fresh: 0, review: 0, reps: 0 });
  c[kind] = Math.max(0, (c[kind] || 0) + delta);
  await db.put('kv', counts, 'dayCounts');
}

export function doneToday(counts, deckIds, kind) {
  return deckIds.reduce((sum, id) => sum + (counts.decks[id]?.[kind] || 0), 0);
}

// --- Médias -------------------------------------------------------------------

const mediaCache = new Map();

// Les médias sont stockés en ArrayBuffer : certains Safari refusent les Blob dans
// IndexedDB. Les anciens enregistrements { blob } restent lisibles.
async function mediaRecord(name, blob) {
  return { name, type: blob.type, data: await blob.arrayBuffer() };
}

function recordBlob(rec) {
  return rec.blob || new Blob([rec.data], { type: rec.type || '' });
}

async function mediaDataUrl(name) {
  if (mediaCache.has(name)) return mediaCache.get(name);
  const rec = await db.get('media', name);
  let url = null;
  if (rec) {
    url = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(recordBlob(rec));
    });
  }
  if (mediaCache.size > 200) mediaCache.delete(mediaCache.keys().next().value);
  mediaCache.set(name, url);
  return url;
}

function decodeName(raw) {
  const txt = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  try { return [txt, decodeURIComponent(txt)]; } catch { return [txt]; }
}

async function resolveMedia(raw) {
  if (/^(https?:|data:|blob:|#)/i.test(raw)) return null;
  for (const name of decodeName(raw)) {
    const url = await mediaDataUrl(name);
    if (url) return url;
  }
  return null;
}

// Remplace les références aux médias (src=, url(), [sound:]) par des data: URL.
export async function inlineMedia(html) {
  const refs = new Set();
  const srcRe = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  const soundRe = /\[sound(-q)?:([^\]]+)\]/g;
  for (const m of html.matchAll(srcRe)) refs.add(m[2] ?? m[3] ?? m[4]);
  for (const m of html.matchAll(urlRe)) refs.add(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(soundRe)) refs.add(m[2]);
  const map = new Map();
  await Promise.all([...refs].map(async (r) => map.set(r, await resolveMedia(r))));
  const sub = (r) => map.get(r) || r;
  let soundIdx = 0;
  return html
    .replace(srcRe, (all, attr, a, b, c) => {
      const r = a ?? b ?? c;
      return map.get(r) ? `${attr}="${sub(r)}"` : all;
    })
    .replace(urlRe, (all, a, b, c) => {
      const r = a ?? b ?? c;
      return map.get(r) ? `url("${sub(r)}")` : all;
    })
    .replace(soundRe, (all, fromQuestion, r) => {
      const url = map.get(r);
      if (!url) return '';
      const auto = fromQuestion ? '' : ' data-autoplay';
      return `<button type="button" class="replay-button" data-sound="${soundIdx++}"${auto} data-src="${url}" aria-label="Écouter">▶</button>`;
    });
}

// --- Notes et cartes créées dans l'application -----------------------------------

let lastId = 0;
export function newId() {
  lastId = Math.max(Date.now(), lastId + 1);
  return lastId;
}

const BUILTIN_CSS = `.card { font-family: system-ui, -apple-system, sans-serif; font-size: 26px; text-align: center; }
.cloze { font-weight: bold; color: #2563eb; }
.nightMode .cloze { color: #7cb4ff; }`;

export const BUILTIN_NOTETYPES = [
  {
    id: 1000000000001, name: 'Basique (Moto)', type: 0, fields: ['Recto', 'Verso'], css: BUILTIN_CSS,
    templates: [{ name: 'Carte 1', qfmt: '{{Recto}}', afmt: '{{FrontSide}}<hr id=answer>{{Verso}}' }],
  },
  {
    id: 1000000000003, name: 'Basique et inversée (Moto)', type: 0, fields: ['Recto', 'Verso'], css: BUILTIN_CSS,
    templates: [
      { name: 'Carte 1', qfmt: '{{Recto}}', afmt: '{{FrontSide}}<hr id=answer>{{Verso}}' },
      { name: 'Carte 2', qfmt: '{{Verso}}', afmt: '{{FrontSide}}<hr id=answer>{{Recto}}' },
    ],
  },
  {
    id: 1000000000004, name: 'Réponse à taper (Moto)', type: 0, fields: ['Recto', 'Verso'], css: BUILTIN_CSS,
    templates: [{ name: 'Carte 1', qfmt: '{{Recto}}<br><br>{{type:Verso}}', afmt: '{{Recto}}<hr id=answer>{{type:Verso}}' }],
  },
  {
    id: 1000000000002, name: 'Texte à trous (Moto)', type: 1, fields: ['Texte', 'Remarque'], css: BUILTIN_CSS,
    templates: [{ name: 'Trou', qfmt: '{{cloze:Texte}}', afmt: '{{cloze:Texte}}<br><small>{{Remarque}}</small>' }],
  },
];

export async function ensureBuiltinNotetypes() {
  const existing = new Set(await db.getAllKeys('notetypes'));
  const missing = BUILTIN_NOTETYPES.filter((nt) => !existing.has(nt.id));
  if (missing.length) await db.putMany('notetypes', missing);
}

async function maxNewPosition() {
  let max = 0;
  for (const c of await db.getAll('cards')) if (c.state === 0) max = Math.max(max, c.due);
  return max;
}

// Numéros (ord) des cartes qu'une note doit produire, comme Anki : une carte par
// modèle dont la question n'est pas vide, ou une par trou pour un texte à trous.
export function cardOrdsFor(notetype, note) {
  if (notetype.type === 1) return clozeOrdinals(note.fields.join(' ')).map((n) => n - 1).sort((a, b) => a - b);
  const blank = { ...note, fields: note.fields.map(() => '') };
  return notetype.templates.map((t, ord) => ord).filter((ord) => {
    const q = renderCard({ notetype, note, card: { ord }, deckName: '' }).question;
    return q !== renderCard({ notetype, note: blank, card: { ord }, deckName: '' }).question;
  });
}

// Enregistre une note (nouvelle ou modifiée) et crée les cartes qui manquent.
// Renvoie le nombre de cartes créées.
export async function saveNote(note, notetype, deckId, { moveCards = false } = {}) {
  if (!note.id) note.id = newId();
  await db.put('notes', note);
  const existing = await db.getAllByIndex('cards', 'nid', note.id);
  const have = new Set(existing.map((c) => c.ord));
  let pos = await maxNewPosition();
  const created = cardOrdsFor(notetype, note).filter((ord) => !have.has(ord)).map((ord) => ({
    id: newId(), nid: note.id, did: deckId, ord, state: 0, due: ++pos,
    ivl: 0, ease: 0, step: 0, reps: 0, lapses: 0, suspended: false,
  }));
  const moved = moveCards ? existing.filter((c) => c.did !== deckId).map((c) => ({ ...c, did: deckId })) : [];
  await db.putMany('cards', [...created, ...moved]);
  return created.length;
}

// Enregistre une image ajoutée depuis l'éditeur et renvoie son nom de média.
export async function addMedia(blob, ext) {
  const name = `moto-${newId()}.${ext}`;
  await db.put('media', await mediaRecord(name, blob));
  return name;
}

export async function mediaObjectUrl(name) {
  const rec = await db.get('media', name);
  return rec ? URL.createObjectURL(recordBlob(rec)) : null;
}

// --- Paquet d'exemple ---------------------------------------------------------

export async function createSampleDeck() {
  const existing = await db.getAll('decks');
  if (existing.some((d) => d.name === 'Exemple::Capitales')) return;
  await ensureBuiltinNotetypes();
  const [basic, , , cloze] = BUILTIN_NOTETYPES;
  const did = await ensureDeck('Exemple::Capitales');
  const pairs = [
    ['Capitale de l’Italie ?', 'Rome'], ['Capitale du Japon ?', 'Tokyo'],
    ['Capitale du Canada ?', 'Ottawa'], ['Capitale de l’Australie ?', 'Canberra'],
    ['Capitale du Maroc ?', 'Rabat'], ['Capitale du Brésil ?', 'Brasília'],
  ];
  for (const [q, a] of pairs) await saveNote({ mid: basic.id, fields: [q, a], tags: ['exemple'] }, basic, did);
  await saveNote({
    mid: cloze.id, tags: ['exemple'],
    fields: ['La tour Eiffel se trouve à {{c1::Paris}} et mesure environ {{c2::330::nombre}} mètres.', 'Inaugurée en 1889'],
  }, cloze, did);
}
