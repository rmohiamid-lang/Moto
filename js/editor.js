// Éditeur de notes : création et modification de cartes, images, textes à trous.
import * as db from './db.js';
import * as col from './collection.js';
import { $, $$, toast, showView, plural } from './ui.js';

const ed = {
  note: null,       // note en cours (null = nouvelle)
  notetype: null,
  raw: [],          // contenu d'origine de chaque champ
  dirty: [],        // champs modifiés par l'utilisateur
  urls: [],         // URL d'objets à libérer à la fermeture
  lastField: null,
  lastRange: null,
  onClose: null,
  originalDeck: null,
};

function remember(key, value) {
  try { localStorage.setItem(`editor.${key}`, String(value)); } catch { /* ignoré */ }
}
function recall(key) {
  try { return localStorage.getItem(`editor.${key}`); } catch { return null; }
}

export function bindEditor() {
  $('#ed-cancel').onclick = () => close();
  $('#ed-save').onclick = () => save();
  $('#ed-delete').onclick = () => removeNote();
  $('#ed-type').onchange = async () => {
    const values = currentValues();
    await setNotetype(Number($('#ed-type').value), values);
  };
  $('#ed-deck').onchange = async () => {
    if ($('#ed-deck').value !== 'new') return;
    const name = prompt('Nom du nouveau paquet (« :: » pour un sous-paquet) :');
    if (name && name.trim()) {
      const id = await col.ensureDeck(name.trim().replace(/\s*::\s*/g, '::'));
      await fillDecks(id);
    } else {
      $('#ed-deck').value = ed.originalDeck ?? $('#ed-deck').options[0]?.value;
    }
  };
  for (const b of $$('#editor .ed-toolbar button')) {
    // Garde la sélection dans le champ quand on touche un bouton de la barre.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => command(b.dataset.cmd);
  }
  $('#ed-image').onchange = () => insertImage();
  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const field = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('.ed-field');
    if (field) {
      ed.lastField = field;
      ed.lastRange = sel.getRangeAt(0).cloneRange();
    }
  });
  $('#editor').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); command('cloze'); }
  });
}

// options : { noteId?, deckId?, onClose? }
export async function openEditor({ noteId = null, deckId = null, onClose = null } = {}) {
  await col.ensureBuiltinNotetypes();
  ed.onClose = onClose;
  ed.note = noteId ? await db.get('notes', noteId) : null;
  const editing = !!ed.note;
  $('#ed-title').textContent = editing ? 'Modifier la note' : 'Ajouter des cartes';
  $('#ed-save').textContent = editing ? 'Enregistrer' : 'Ajouter';
  $('#ed-delete').hidden = !editing;
  $('#ed-type').disabled = editing;

  const builtin = new Set(col.BUILTIN_NOTETYPES.map((nt) => nt.id));
  const notetypes = (await db.getAll('notetypes'))
    .sort((a, b) => builtin.has(b.id) - builtin.has(a.id) || a.name.localeCompare(b.name, 'fr'));
  $('#ed-type').innerHTML = notetypes.map((nt) => `<option value="${nt.id}"></option>`).join('');
  $$('#ed-type option').forEach((o, i) => { o.textContent = notetypes[i].name; });

  let did = deckId;
  if (editing) {
    const cards = await db.getAllByIndex('cards', 'nid', noteId);
    did = cards[0]?.did ?? null;
  }
  did ??= Number(recall('deck')) || null;
  await fillDecks(did);
  ed.originalDeck = $('#ed-deck').value;

  const mid = editing ? ed.note.mid : Number(recall('type')) || notetypes[0].id;
  const type = notetypes.some((n) => n.id === mid) ? mid : notetypes[0].id;
  $('#ed-type').value = type;
  $('#ed-tags').value = editing ? ed.note.tags.join(' ') : (recall('tags') || '');
  showView('editor');
  await setNotetype(type, editing ? ed.note.fields : null, editing);
  focusFirst();
}

async function fillDecks(selectedId) {
  const decks = (await db.getAll('decks')).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  if (!decks.length) decks.push({ id: await col.ensureDeck('Mes cartes'), name: 'Mes cartes' });
  const sel = $('#ed-deck');
  sel.innerHTML = '';
  for (const d of decks) sel.add(new Option(d.name.split('::').join(' › '), d.id));
  sel.add(new Option('+ Nouveau paquet…', 'new'));
  sel.value = decks.some((d) => d.id === selectedId) ? selectedId : decks[0].id;
}

async function setNotetype(id, values, fromNote = false) {
  ed.notetype = await db.get('notetypes', id);
  const nt = ed.notetype;
  ed.raw = nt.fields.map((_, i) => (values?.[i] ?? ''));
  ed.dirty = nt.fields.map(() => !fromNote);
  freeUrls();
  const box = $('#ed-fields');
  box.innerHTML = '';
  nt.fields.forEach((name, i) => {
    const label = document.createElement('label');
    label.className = 'ed-label';
    label.textContent = name;
    const field = document.createElement('div');
    field.className = 'ed-field';
    field.contentEditable = 'true';
    field.dataset.index = i;
    field.addEventListener('input', () => { ed.dirty[i] = true; });
    field.addEventListener('paste', onPaste);
    box.append(label, field);
    loadField(field, ed.raw[i]);
  });
  $('#ed-cloze').hidden = nt.type !== 1;
  updateInfo();
}

// Affiche un champ sans exécuter le code éventuellement présent dans le HTML.
function loadField(field, html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.querySelectorAll('script, iframe, object, embed, link, meta, style, base, form')) el.remove();
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
  const imgs = [...doc.body.querySelectorAll('img')];
  field.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  imgs.forEach((_, k) => {
    const img = field.querySelectorAll('img')[k];
    const src = img?.getAttribute('src');
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return;
    img.dataset.media = src;
    img.removeAttribute('src');
    col.mediaObjectUrl(src).then((url) => {
      if (url) { ed.urls.push(url); img.src = url; }
    });
  });
}

function serialize(field) {
  const clone = field.cloneNode(true);
  for (const img of clone.querySelectorAll('img[data-media]')) {
    img.setAttribute('src', img.dataset.media);
    img.removeAttribute('data-media');
  }
  const html = clone.innerHTML.trim();
  return /^(<br\s*\/?>|&nbsp;|\s)*$/i.test(html) ? '' : html;
}

function currentValues() {
  return $$('#ed-fields .ed-field').map((f, i) => (ed.dirty[i] ? serialize(f) : ed.raw[i]));
}

function onPaste(e) {
  // Colle le texte brut pour éviter d'importer des styles indésirables.
  const text = e.clipboardData?.getData('text/plain');
  if (text == null || e.clipboardData.files?.length) return;
  e.preventDefault();
  document.execCommand('insertText', false, text);
}

function focusFirst() {
  const f = $('#ed-fields .ed-field');
  if (!f) return;
  f.focus();
  const range = document.createRange();
  range.selectNodeContents(f);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function restoreSelection() {
  if (!ed.lastField || !ed.lastField.isConnected) {
    ed.lastField = $('#ed-fields .ed-field');
    ed.lastRange = null;
  }
  ed.lastField.focus();
  if (ed.lastRange) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(ed.lastRange);
  }
}

function command(cmd) {
  if (cmd === 'image') { $('#ed-image').click(); return; }
  restoreSelection();
  if (cmd === 'cloze') {
    const all = currentValues().join(' ');
    const n = Math.max(0, ...[...all.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]))) + 1;
    const sel = getSelection();
    const div = document.createElement('div');
    if (sel.rangeCount) div.append(sel.getRangeAt(0).cloneContents());
    document.execCommand('insertHTML', false, `{{c${n}::${div.innerHTML}}}`);
  } else {
    document.execCommand(cmd, false, null);
  }
  ed.dirty[Number(ed.lastField.dataset.index)] = true;
}

async function insertImage() {
  const file = $('#ed-image').files[0];
  $('#ed-image').value = '';
  if (!file) return;
  try {
    const { blob, ext } = await shrinkImage(file);
    const name = await col.addMedia(blob, ext);
    const url = URL.createObjectURL(blob);
    ed.urls.push(url);
    restoreSelection();
    document.execCommand('insertHTML', false, `<img src="${url}" data-media="${name}">`);
    ed.dirty[Number(ed.lastField.dataset.index)] = true;
  } catch (err) {
    console.error(err);
    toast('Impossible d’ajouter cette image.');
  }
}

// Réduit les photos (souvent plusieurs Mo) pour économiser la place sur l'appareil.
async function shrinkImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  if (/gif|svg/.test(file.type)) return { blob: file, ext };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 500 * 1024 && /jpe?g|png|webp/.test(ext)) return { blob: file, ext };
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { blob, ext: 'jpg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function updateInfo() {
  const info = $('#ed-cards-info');
  info.textContent = ed.notetype.type === 1
    ? 'Sélectionnez un mot puis touchez […] pour créer un trou : chaque trou donne une carte.'
    : `Ce type crée ${plural(ed.notetype.templates.length, 'carte')} par note (si le recto est rempli).`;
}

async function save() {
  const fields = currentValues();
  const tags = $('#ed-tags').value.trim().split(/\s+/).filter(Boolean);
  const deckId = Number($('#ed-deck').value);
  if (!deckId) { toast('Choisissez un paquet.'); return; }
  const editing = !!ed.note;
  const note = editing ? { ...ed.note, fields, tags } : { mid: ed.notetype.id, fields, tags };
  if (!editing) {
    const ords = col.cardOrdsFor(ed.notetype, { ...note, id: 0 });
    if (!ords.length) {
      toast(ed.notetype.type === 1
        ? 'Ajoutez au moins un trou, par exemple {{c1::réponse}}.'
        : 'Le recto est vide : aucune carte ne serait créée.', 5000);
      return;
    }
  }
  const created = await col.saveNote(note, ed.notetype, deckId, { moveCards: editing && String(deckId) !== ed.originalDeck });
  remember('deck', deckId);
  if (editing) {
    toast(created ? `Note enregistrée, ${plural(created, 'nouvelle carte', 'nouvelles cartes')}.` : 'Note enregistrée.');
    close();
    return;
  }
  remember('type', ed.notetype.id);
  remember('tags', tags.join(' '));
  toast(`${plural(created, 'carte ajoutée', 'cartes ajoutées')}.`);
  await setNotetype(ed.notetype.id, null);
  focusFirst();
}

async function removeNote() {
  if (!ed.note) return;
  const cards = await db.getAllByIndex('cards', 'nid', ed.note.id);
  if (!confirm(`Supprimer cette note et ses ${plural(cards.length, 'carte')} ? Cette action est définitive.`)) return;
  await col.deleteCards(cards.map((c) => c.id));
  toast('Note supprimée.');
  close({ deleted: true });
}

function freeUrls() {
  for (const u of ed.urls) URL.revokeObjectURL(u);
  ed.urls = [];
}

function close(result = {}) {
  freeUrls();
  const cb = ed.onClose;
  ed.onClose = null;
  ed.note = null;
  $('#ed-fields').innerHTML = '';
  if (cb) cb(result);
}
