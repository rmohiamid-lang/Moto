// Petits utilitaires d'interface partagés par les écrans.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VIEWS = ['home', 'study', 'browse', 'stats', 'editor'];

export function showView(name) {
  for (const v of VIEWS) $(`#${v}`).hidden = v !== name;
}

export function currentView() {
  return VIEWS.find((v) => !$(`#${v}`).hidden);
}

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function openMenu(anchor, items) {
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
  menu.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', function close(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
  }), 0);
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n > 1 ? pluralWord : word}`;
}

// Texte « à plat » sans accents ni majuscules, pour la recherche.
export function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
