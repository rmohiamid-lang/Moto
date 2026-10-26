// État partagé de l'application et limites quotidiennes par paquet.
import { doneToday } from './collection.js';

export const state = {
  settings: null,   // réglages globaux
  counts: null,     // compteurs du jour (collection.loadDayCounts)
  tree: null,       // arborescence des paquets (collection.buildTree)
  decks: [],        // liste des paquets
  collapsed: new Set(),
  session: null,    // session de révision en cours
};

export function findNode(fullName, node = state.tree) {
  if (!node) return null;
  if (node.fullName === fullName) return node;
  for (const c of node.children) {
    const f = findNode(fullName, c);
    if (f) return f;
  }
  return null;
}

// Réglage d'un paquet, ou réglage global s'il n'est pas personnalisé.
export function deckSetting(deck, key) {
  const v = deck?.conf?.[key];
  return v === undefined || v === null || v === '' ? state.settings[key] : v;
}

// Renvoie take(card, kind) qui consomme les limites quotidiennes du paquet de la
// carte et de chacun de ses parents (jusqu'au paquet étudié), comme Anki.
export function makeLimiter(node) {
  const { counts } = state;
  const remaining = new Map();
  const visit = (n) => {
    const extra = counts.extra?.[n.fullName] || {};
    remaining.set(n.fullName, {
      fresh: deckSetting(n.deck, 'newPerDay') + (extra.fresh || 0) - doneToday(counts, n.ids, 'fresh'),
      review: deckSetting(n.deck, 'reviewsPerDay') + (extra.review || 0) - doneToday(counts, n.ids, 'review'),
    });
    n.children.forEach(visit);
  };
  visit(node);
  const nameById = new Map(state.decks.map((d) => [d.id, d.name]));
  const chains = new Map();
  const chainOf = (did) => {
    if (chains.has(did)) return chains.get(did);
    const parts = (nameById.get(did) || '').split('::');
    const chain = [];
    for (let i = parts.length; i > 0; i--) {
      const r = remaining.get(parts.slice(0, i).join('::'));
      if (r) chain.push(r);
    }
    chains.set(did, chain);
    return chain;
  };
  return (card, kind) => {
    const chain = chainOf(card.did);
    if (!chain.length || chain.some((r) => r[kind] <= 0)) return false;
    for (const r of chain) r[kind]--;
    return true;
  };
}
