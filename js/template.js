// Moteur de modèles compatible Anki : {{Champ}}, {{#Champ}}…{{/Champ}}, {{^Champ}},
// filtres (cloze, text, hint, type, furigana…), {{FrontSide}} et champs spéciaux.

export function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const isNonEmpty = (v) => stripHtml(v ?? '').trim() !== '';

// --- Analyse du modèle -----------------------------------------------------

function parseTemplate(src) {
  const root = { children: [] };
  const stack = [root];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push(src.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1].trim();
    if (tag[0] === '#' || tag[0] === '^') {
      const node = { section: tag.slice(1).trim(), negated: tag[0] === '^', children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (tag[0] === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      top.children.push({ tag });
    }
  }
  if (last < src.length) stack[stack.length - 1].children.push(src.slice(last));
  return root;
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') out += n;
    else if (n.section !== undefined) {
      if (sectionTrue(n.section, ctx) !== n.negated) out += renderNodes(n.children, ctx);
    } else out += renderTag(n.tag, ctx);
  }
  return out;
}

function sectionTrue(name, ctx) {
  const cm = /^c(\d+)$/.exec(name);
  if (cm && ctx.isCloze && !(name in ctx.fields)) return Number(cm[1]) === ctx.clozeOrd;
  return isNonEmpty(fieldValue(name, ctx));
}

function fieldValue(name, ctx) {
  if (name === 'FrontSide') return ctx.frontSide ?? '';
  return ctx.fields[name] ?? ctx.special[name] ?? '';
}

function renderTag(tag, ctx) {
  const parts = tag.split(':');
  const name = parts.pop().trim();
  const filters = parts.map((f) => f.trim());
  if (name === 'FrontSide' && !filters.length) return ctx.frontSide ?? '';
  let value = fieldValue(name, ctx);
  // Les filtres s'appliquent de droite à gauche.
  for (let i = filters.length - 1; i >= 0; i--) value = applyFilter(filters[i], value, ctx, name);
  return value;
}

function applyFilter(filter, value, ctx, fieldName) {
  const f = filter.toLowerCase();
  switch (f) {
    case 'cloze': return renderCloze(value, ctx.clozeOrd, ctx.side);
    case 'cloze-only': return clozeAnswers(value, ctx.clozeOrd).join(', ');
    case 'text': return escapeHtml(stripHtml(value));
    case 'hint':
      if (!isNonEmpty(value)) return '';
      return `<details class="hint"><summary>${escapeHtml(fieldName)}</summary>${value}</details>`;
    case 'type': return renderTypeAnswer(value, ctx);
    case 'furigana': return furigana(value, (base, ruby) => `<ruby><rb>${base}</rb><rt>${ruby}</rt></ruby>`);
    case 'kana': return furigana(value, (base, ruby) => ruby);
    case 'kanji': return furigana(value, (base) => base);
    default:
      // {{tts fr_FR:Champ}} : on note la langue pour la lecture à voix haute.
      if (f.startsWith('tts ')) return ttsSpan(filter.slice(4).trim().split(/\s+/)[0], value);
      // Filtres d'extensions inconnus : on garde le contenu tel quel.
      return value;
  }
}

// Comme dans Anki, le texte à lire n'est pas affiché : il sert à la lecture à voix haute.
function ttsSpan(lang, html) {
  return `<span class="tts-text" data-tts-lang="${escapeHtml(lang.replace('_', '-'))}" hidden>${html}</span>`;
}

// Balises [anki:tts lang=fr_FR]…[/anki:tts] présentes dans certains paquets.
function ankiTtsTags(html) {
  return html.replace(/\[anki:tts([^\]]*)\]([\s\S]*?)\[\/anki:tts\]/g, (_, attrs, text) => {
    const lang = /lang=([\w-]+)/.exec(attrs);
    return lang ? ttsSpan(lang[1], text) : text;
  });
}

function furigana(value, fn) {
  return value.replace(/ ?([^ >[]+?)\[(.+?)\]/g, (_, base, ruby) => fn(base, ruby));
}

// --- Texte à trous (cloze) --------------------------------------------------

function parseCloze(text) {
  const root = { children: [] };
  const stack = [root];
  const re = /\{\{c(\d+)::|\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      top.children.push(text.slice(last, m.index));
      const node = { ord: Number(m[1]), children: [] };
      top.children.push(node);
      stack.push(node);
    } else {
      if (stack.length === 1) continue; // « }} » orphelin : laissé dans le texte
      top.children.push(text.slice(last, m.index));
      stack.pop();
    }
    last = re.lastIndex;
  }
  stack[stack.length - 1].children.push(text.slice(last));
  for (const node of stack.slice(1)) splitHint(node);
  walk(root);
  return root;

  function walk(n) {
    for (const c of n.children) if (typeof c !== 'string') { splitHint(c); walk(c); }
  }
}

// L'indice d'un trou est le texte après le dernier « :: » de son propre contenu.
function splitHint(node) {
  if (node.hint !== undefined) return;
  node.hint = '';
  for (let i = node.children.length - 1; i >= 0; i--) {
    const c = node.children[i];
    if (typeof c === 'string' && c.includes('::')) {
      const at = c.lastIndexOf('::');
      node.hint = c.slice(at + 2);
      node.children.splice(i, 1, c.slice(0, at));
      node.children.length = i + 1;
      break;
    }
  }
}

function clozeText(node, ord, side) {
  return node.children.map((c) => {
    if (typeof c === 'string') return c;
    const inner = clozeText(c, ord, side);
    if (c.ord !== ord) return `<span class="cloze-inactive" data-ordinal="${c.ord}">${inner}</span>`;
    if (side === 'q') {
      return `<span class="cloze" data-ordinal="${c.ord}">[${c.hint ? c.hint : '...'}]</span>`;
    }
    return `<span class="cloze" data-ordinal="${c.ord}">${inner}</span>`;
  }).join('');
}

function renderCloze(text, ord, side) {
  return clozeText(parseCloze(text), ord, side);
}

function clozeAnswers(text, ord) {
  const out = [];
  (function collect(node) {
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      if (c.ord === ord) out.push(stripHtml(clozeText(c, -1, 'a')));
      else collect(c);
    }
  })(parseCloze(text));
  return out;
}

export function clozeOrdinals(text) {
  return [...new Set([...text.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1])))];
}

// --- Saisie de la réponse ({{type:Champ}}) ---------------------------------

function renderTypeAnswer(value, ctx) {
  if (ctx.side === 'q') {
    ctx.expectsTyping = true;
    return '<input id="typeans" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Votre réponse">';
  }
  const expected = stripHtml(ctx.typeCloze ? clozeAnswers(value, ctx.clozeOrd).join(', ') : value).trim();
  return compareAnswer(expected, (ctx.typed || '').trim());
}

export function compareAnswer(expected, typed) {
  if (!typed) return `<div id="typeans"><code class="typeMissed">${escapeHtml(expected)}</code></div>`;
  if (typed === expected) return `<div id="typeans"><code class="typeGood">${escapeHtml(typed)}</code></div>`;
  // Diff caractère par caractère (plus longue sous-séquence commune).
  const a = [...typed], b = [...expected];
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  let i = 0, j = 0, got = '', want = '';
  const span = (cls, s) => `<span class="${cls}">${escapeHtml(s)}</span>`;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      got += span('typeGood', a[i]); want += span('typeGood', b[j]); i++; j++;
    } else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) {
      want += span('typeMissed', b[j]); j++;
    } else {
      got += span('typeBad', a[i]); i++;
    }
  }
  return `<div id="typeans"><code>${got}</code><br><span class="typeArrow">↓</span><br><code>${want}</code></div>`;
}

// --- Rendu d'une carte -------------------------------------------------------

// Renvoie { question, answer } en HTML (médias encore référencés par leur nom).
export function renderCard({ notetype, note, card, deckName, typed }) {
  const isCloze = notetype.type === 1;
  const tmpl = isCloze ? notetype.templates[0] : notetype.templates[card.ord];
  if (!tmpl) return { question: '<p>Modèle de carte introuvable.</p>', answer: '' };
  const fields = {};
  notetype.fields.forEach((name, i) => { fields[name] = note.fields[i] ?? ''; });
  const parts = deckName.split('::');
  const ctx = {
    fields,
    special: {
      Tags: note.tags.join(' '),
      Deck: deckName,
      Subdeck: parts[parts.length - 1],
      Card: tmpl.name,
      Type: notetype.name,
      CardFlag: '',
    },
    isCloze,
    clozeOrd: card.ord + 1,
    typeCloze: isCloze && /\{\{\s*type:cloze:/.test(tmpl.qfmt),
    typed,
  };
  const qCtx = { ...ctx, side: 'q' };
  const question = ankiTtsTags(renderNodes(parseTemplate(tmpl.qfmt).children, qCtx));
  const answer = ankiTtsTags(renderNodes(parseTemplate(tmpl.afmt).children, {
    ...ctx, side: 'a', frontSide: stripTypeInput(question),
  }));
  return { question, answer, expectsTyping: !!qCtx.expectsTyping };
}

// {{FrontSide}} : sans le champ de saisie, et ses sons ne sont pas rejoués automatiquement.
function stripTypeInput(html) {
  return html.replace(/<input id="typeans"[^>]*>/g, '').replace(/\[sound:/g, '[sound-q:');
}
