import * as db from './db.js';
import * as col from './collection.js';
import { escapeHtml } from './template.js';
import { buildQueues, dayNumber } from './scheduler.js';
import { state, findNode, makeLimiter } from './state.js';
import { $, toast, showView, openMenu, plural } from './ui.js';
import { bindStudy, startStudy, startCustom } from './study.js';
import { bindEditor, openEditor } from './editor.js';
import { bindBrowse, openBrowser } from './browse.js';
import { bindStats, openStats } from './stats.js';
import { TTS_LANGUAGES, ttsAvailable, unlockOnFirstTouch } from './tts.js';
import { badgeSupported, enableBadge, updateBadge, downloadReminder } from './reminders.js';

// --- Démarrage ---------------------------------------------------------------

async function init() {
  // En premier : même si la suite plantait, une version corrigée pourra s'installer.
  registerServiceWorker();
  state.settings = await col.loadSettings();
  state.goHome = showHome;
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch { /* stockage indisponible */ }
  applyTheme();
  bindHome();
  bindStudy();
  bindEditor();
  bindBrowse();
  bindStats();
  bindSettings();
  bindDeckDialogs();
  bindDragDrop();
  bindInstall();
  unlockOnFirstTouch();
  window.__motoReady = true; // les boutons sont prêts (voir le filet de sécurité dans index.html)
  await showHome();

  navigator.storage?.persist?.().catch(() => {});

  // Ouverture d'un .apkg depuis le système (PWA installée sur ordinateur).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = await Promise.all((params.files || []).map((h) => h.getFile()));
      if (files.length) importFiles(files);
    });
  }
  // Les compteurs changent quand on revient sur l'appli le lendemain.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#home').hidden) renderDeckList();
  });
}

// Mises à jour : quand une nouvelle version s'installe, la page se recharge pour
// l'utiliser en entier (pendant une révision, on attend le retour à l'accueil).
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Une appli installée sur iPad reprend souvent sans recharger : on vérifie au retour.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || state.updateReady) return;
    state.updateReady = true;
    reloadIfIdle();
  });
}

function reloadIfIdle() {
  if (state.updateReady && !$('#home').hidden && !document.querySelector('dialog[open]')) location.reload();
}

async function appVersion() {
  const keys = await caches?.keys?.().catch(() => []) || [];
  const key = keys.find((k) => k.startsWith('moto-'));
  return key ? key.slice(5) : 'inconnue';
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
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
  $('#btn-add').onclick = () => openEditor({ onClose: showHome });
  $('#btn-browse').onclick = () => openBrowser();
  $('#btn-stats').onclick = () => openStats();
  $('#deck-list').addEventListener('click', onDeckListClick);
}

async function showHome() {
  state.session = null;
  showView('home');
  reloadIfIdle();
  await renderDeckList();
}

async function renderDeckList() {
  const [decks, cards, counts] = await Promise.all([
    db.getAll('decks'), db.getAll('cards'), col.loadDayCounts(state.settings),
  ]);
  state.counts = counts;
  state.decks = decks;
  const byDeck = new Map();
  for (const c of cards) {
    if (!byDeck.has(c.did)) byDeck.set(c.did, []);
    byDeck.get(c.did).push(c);
  }
  const tree = col.buildTree(decks);
  state.tree = tree;
  const now = Date.now();
  const rowsHtml = [];
  let dueTotal = 0;
  const walk = (node, depth) => {
    const subCards = node.ids.flatMap((id) => byDeck.get(id) || []);
    const q = buildQueues(subCards, now, state.settings, makeLimiter(node));
    if (depth === 0) dueTotal += q.fresh.length + q.learnToday.length + q.review.length;
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
    ? `${plural(cards.length, 'carte')} · ${plural(reps, 'révision')} aujourd’hui` : '';
  updateBadge(dueTotal);
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
      ['Révision personnalisée…', () => openCustomStudy(node)],
      ['Ajouter des cartes', () => openEditor({ deckId: node.deck?.id, onClose: showHome })],
      ['Parcourir les cartes', () => openBrowser({ deckName: node.fullName })],
      ['Statistiques', () => openStats(node.fullName)],
      ['Options du paquet…', () => openDeckOptions(node)],
      ['Renommer', () => renameDeck(node)],
      ['Supprimer', () => deleteDeck(node), 'danger'],
    ]);
  }
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
  if (!confirm(`Supprimer « ${node.fullName} » et ses ${plural(cards, 'carte')} ? Cette action est définitive.`)) return;
  await col.deleteDecks(node.ids);
  toast('Paquet supprimé.');
  renderDeckList();
}

// --- Options d'un paquet et révision personnalisée ---------------------------------

function fillLanguages(select, firstLabel) {
  select.innerHTML = '';
  TTS_LANGUAGES.forEach(([code, label], i) => select.add(new Option(i === 0 && firstLabel ? firstLabel : label, code)));
}

let dialogNode = null;

function bindDeckDialogs() {
  const optDlg = $('#deck-options-dialog');
  optDlg.addEventListener('close', async () => {
    if (optDlg.returnValue !== 'save' || !dialogNode) return;
    const f = $('#deck-options-form');
    const num = (v) => (v.trim() === '' ? undefined : Math.max(0, Number(v)));
    let deck = dialogNode.deck;
    if (!deck) deck = await db.get('decks', await col.ensureDeck(dialogNode.fullName));
    const conf = { newPerDay: num(f.newPerDay.value), reviewsPerDay: num(f.reviewsPerDay.value), ttsLang: f.ttsLang.value || undefined };
    for (const k of Object.keys(conf)) if (conf[k] === undefined) delete conf[k];
    await db.put('decks', { ...deck, conf });
    toast('Options du paquet enregistrées.');
    renderDeckList();
  });

  const csDlg = $('#custom-study-dialog');
  const form = $('#custom-study-form');
  form.addEventListener('change', () => {
    for (const el of form.querySelectorAll('[data-for]')) el.disabled = el.dataset.for !== form.mode.value;
  });
  csDlg.addEventListener('close', () => {
    if (csDlg.returnValue === 'go' && dialogNode) runCustomStudy(dialogNode, form);
  });
}

function openDeckOptions(node) {
  dialogNode = node;
  const f = $('#deck-options-form');
  $('#deck-options-title').textContent = node.fullName;
  f.newPerDay.value = node.deck?.conf?.newPerDay ?? '';
  f.reviewsPerDay.value = node.deck?.conf?.reviewsPerDay ?? '';
  f.newPerDay.placeholder = `${state.settings.newPerDay} (réglage général)`;
  f.reviewsPerDay.placeholder = `${state.settings.reviewsPerDay} (réglage général)`;
  fillLanguages(f.ttsLang, 'Réglage général');
  f.ttsLang.value = node.deck?.conf?.ttsLang ?? '';
  $('#deck-options-dialog').showModal();
}

async function openCustomStudy(node) {
  dialogNode = node;
  const form = $('#custom-study-form');
  $('#custom-study-title').textContent = node.fullName;
  const ids = new Set(node.ids);
  const nids = new Set((await db.getAll('cards')).filter((c) => ids.has(c.did)).map((c) => c.nid));
  const tags = new Set();
  for (const n of await db.getAll('notes')) if (nids.has(n.id)) n.tags.forEach((t) => tags.add(t));
  const sel = form.tag;
  sel.innerHTML = '';
  for (const t of [...tags].sort((a, b) => a.localeCompare(b, 'fr'))) sel.add(new Option(t, t));
  form.querySelector('[value="tag"]').disabled = tags.size === 0;
  form.mode.value = 'extraNew';
  form.dispatchEvent(new Event('change'));
  $('#custom-study-dialog').showModal();
}

async function runCustomStudy(node, form) {
  const mode = form.mode.value;
  const ids = new Set(node.ids);
  const cards = (await db.getAll('cards')).filter((c) => ids.has(c.did) && !c.suspended);
  const today = dayNumber(Date.now(), state.settings);
  if (mode === 'extraNew' || mode === 'extraReview') {
    const n = Math.max(1, Number(form[mode].value) || 0);
    await col.addExtraLimit(state.counts, node.fullName, mode === 'extraNew' ? 'fresh' : 'review', n);
    toast(mode === 'extraNew' ? `+${n} nouvelles cartes aujourd’hui.` : `+${n} révisions aujourd’hui.`);
    startStudy(node);
    return;
  }
  let list = [];
  let title = node.fullName;
  if (mode === 'forgotten') {
    const start = Date.now() - 86400000;
    const forgotten = new Set((await db.getAll('revlog')).filter((l) => l.id >= start && l.rating === 1).map((l) => l.cid));
    list = cards.filter((c) => forgotten.has(c.id));
    title += ' · oubliées';
  } else if (mode === 'ahead') {
    const days = Math.max(1, Number(form.ahead.value) || 1);
    list = cards.filter((c) => c.state === 2 && c.due > today && c.due <= today + days).sort((a, b) => a.due - b.due);
    title += ' · en avance';
  } else if (mode === 'tag') {
    const tag = form.tag.value;
    const nids = new Set((await db.getAll('notes')).filter((n) => n.tags.includes(tag)).map((n) => n.id));
    list = cards.filter((c) => nids.has(c.nid));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    list = list.slice(0, 200);
    title += ` · ${tag}`;
  }
  if (!list.length) { toast('Aucune carte ne correspond.'); return; }
  startCustom(node, list, title);
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
      toast(`${file.name} : ${plural(r.cards, 'carte importée', 'cartes importées')}${extra}, ${plural(r.media, 'média', 'médias')}.`, 5000);
    }
  } catch (err) {
    console.error(err);
    toast(`Échec de l’import : ${err?.message || err || 'erreur inconnue'}`, 7000);
  } finally {
    dlg.close();
    if (!$('#home').hidden) renderDeckList();
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

// --- Réglages ----------------------------------------------------------------

function bindSettings() {
  const dlg = $('#settings-dialog');
  const form = $('#settings-form');
  fillLanguages(form.ttsLang);
  $('#tts-settings').hidden = !ttsAvailable();
  $('#btn-badge').hidden = !badgeSupported();
  $('#btn-settings').onclick = async () => {
    const s = state.settings;
    form.newPerDay.value = s.newPerDay;
    form.reviewsPerDay.value = s.reviewsPerDay;
    form.learnSteps.value = s.learnSteps.join(' ');
    form.relearnSteps.value = s.relearnSteps.join(' ');
    form.algorithm.value = s.algorithm;
    form.retention.value = Math.round(s.retention * 100);
    form.graduatingIvl.value = s.graduatingIvl;
    form.easyIvl.value = s.easyIvl;
    form.dayStartHour.value = s.dayStartHour;
    form.theme.value = s.theme;
    form.gestures.checked = s.gestures;
    form.autoTts.checked = s.autoTts;
    form.ttsLang.value = s.ttsLang;
    form.reminderTime.value = s.reminderTime;
    form.dispatchEvent(new Event('change'));
    $('#storage-info').textContent = '';
    dlg.showModal();
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const usage = est?.usage != null ? `Espace utilisé sur l’appareil : ${(est.usage / 1048576).toFixed(1)} Mo. ` : '';
    $('#storage-info').textContent = `${usage}Version : ${await appVersion()}.`;
  };
  form.addEventListener('change', () => {
    const fsrs = form.algorithm.value === 'fsrs';
    $('#fsrs-settings').hidden = !fsrs;
    $('#sm2-settings').hidden = fsrs;
  });
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const steps = (v) => v.split(/[\s,;]+/).map((x) => parseFloat(x.replace(',', '.'))).filter((x) => x > 0);
    state.settings = {
      ...state.settings,
      newPerDay: Number(form.newPerDay.value),
      reviewsPerDay: Number(form.reviewsPerDay.value),
      learnSteps: steps(form.learnSteps.value),
      relearnSteps: steps(form.relearnSteps.value),
      algorithm: form.algorithm.value,
      retention: Math.min(0.99, Math.max(0.7, Number(form.retention.value) / 100)),
      graduatingIvl: Number(form.graduatingIvl.value),
      easyIvl: Number(form.easyIvl.value),
      dayStartHour: Number(form.dayStartHour.value),
      theme: form.theme.value,
      gestures: form.gestures.checked,
      autoTts: form.autoTts.checked,
      ttsLang: form.ttsLang.value,
      reminderTime: form.reminderTime.value || '19:00',
    };
    await col.saveSettings(state.settings);
    applyTheme();
    renderDeckList();
    toast('Réglages enregistrés.');
  });
  $('#btn-reminder').onclick = () => {
    downloadReminder(form.reminderTime.value || '19:00');
    toast('Ouvrez le fichier « rappel-moto.ics » puis touchez « Ajouter » pour le mettre dans votre Calendrier.', 8000);
  };
  $('#btn-badge').onclick = async () => {
    const ok = await enableBadge();
    toast(ok ? 'Le nombre de cartes à revoir s’affichera sur l’icône.' : 'Autorisation refusée : le badge ne peut pas s’afficher.', 5000);
    if (ok) renderDeckList();
  };
  $('#btn-wipe').onclick = async () => {
    if (!confirm('Effacer tous les paquets, cartes, médias et la progression ? Cette action est définitive.')) return;
    await db.clearAll();
    state.settings = await col.loadSettings();
    applyTheme();
    dlg.close();
    renderDeckList();
    toast('Toutes les données ont été effacées.');
  };
}

init();
