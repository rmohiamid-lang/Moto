// Lecture des paquets Anki (.apkg / .colpkg).
// Gère l'ancien format (collection.anki2 / .anki21, JSON dans la table col)
// et le nouveau (collection.anki21b compressé zstd, schéma 18 + protobuf).
/* global JSZip, initSqlJs, fzstd */

const COLLECTION_NAMES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];

let sqlPromise = null;
function getSql() {
  sqlPromise ??= initSqlJs({ locateFile: (f) => `vendor/${f}` });
  return sqlPromise;
}

function isZstd(u8) {
  return u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;
}

function maybeZstd(u8) {
  return isZstd(u8) ? fzstd.decompress(u8) : u8;
}

// Décodeur protobuf minimal : renvoie { numéroDeChamp: [valeurs...] }.
// Les valeurs varint sont des nombres, les champs « length-delimited » des Uint8Array.
function readProto(u8) {
  const out = {};
  let i = 0;
  const varint = () => {
    let result = 0, mul = 1, b;
    do {
      b = u8[i++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  };
  while (i < u8.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    let val;
    if (wire === 0) val = varint();
    else if (wire === 2) { const len = varint(); val = u8.subarray(i, i + len); i += len; }
    else if (wire === 1) { val = u8.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { val = u8.subarray(i, i + 4); i += 4; }
    else throw new Error('Protobuf invalide');
    (out[field] ??= []).push(val);
  }
  return out;
}

const utf8 = new TextDecoder();
const protoStr = (msg, f) => (msg[f] ? utf8.decode(msg[f][0]) : '');
const protoInt = (msg, f) => (msg[f] ? msg[f][0] : 0);

function rows(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

function readLegacyModels(db) {
  const [col] = rows(db, 'select crt, models, decks from col');
  const models = JSON.parse(col.models || '{}');
  const decks = JSON.parse(col.decks || '{}');
  return {
    crt: col.crt,
    notetypes: Object.values(models).map((m) => ({
      id: Number(m.id),
      name: m.name,
      type: m.type === 1 ? 1 : 0,
      css: m.css || '',
      fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: [...m.tmpls].sort((a, b) => a.ord - b.ord)
        .map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
    })),
    decks: Object.values(decks).map((d) => ({ id: Number(d.id), name: d.name })),
  };
}

function readV18Models(db) {
  const [col] = rows(db, 'select crt from col');
  const fieldsByNt = new Map();
  for (const f of rows(db, 'select ntid, ord, name from fields order by ntid, ord')) {
    if (!fieldsByNt.has(f.ntid)) fieldsByNt.set(f.ntid, []);
    fieldsByNt.get(f.ntid).push(f.name);
  }
  const tmplsByNt = new Map();
  for (const t of rows(db, 'select ntid, ord, name, config from templates order by ntid, ord')) {
    const cfg = readProto(t.config);
    if (!tmplsByNt.has(t.ntid)) tmplsByNt.set(t.ntid, []);
    tmplsByNt.get(t.ntid).push({ name: t.name, qfmt: protoStr(cfg, 1), afmt: protoStr(cfg, 2) });
  }
  return {
    crt: col.crt,
    notetypes: rows(db, 'select id, name, config from notetypes').map((nt) => {
      const cfg = readProto(nt.config);
      return {
        id: nt.id,
        name: nt.name,
        type: protoInt(cfg, 1) === 1 ? 1 : 0,
        css: protoStr(cfg, 3),
        fields: fieldsByNt.get(nt.id) || [],
        templates: tmplsByNt.get(nt.id) || [],
      };
    }),
    decks: rows(db, 'select id, name from decks')
      .map((d) => ({ id: d.id, name: d.name.split('\x1f').join('::') })),
  };
}

// Convertit l'état de planification d'Anki vers le nôtre (voir scheduler.js).
function convertCard(c, crt) {
  const card = {
    id: c.id, nid: c.nid, did: c.odid || c.did, ord: c.ord,
    state: 0, due: 0, ivl: 0, ease: 0, step: 0,
    reps: c.reps, lapses: c.lapses, suspended: c.queue === -1,
  };
  if (c.type === 2 || (c.type === 3 && c.ivl > 0)) {
    const dueTs = c.type === 2 && c.queue === 2 ? (crt + c.due * 86400) * 1000 : Date.now();
    card.state = 2;
    card.ivl = Math.max(1, c.ivl);
    card.ease = c.factor || 2500;
    card.dueTs = dueTs; // converti en numéro de jour à l'import
  } else {
    card.due = c.type === 0 ? c.due : 0;
  }
  return card;
}

function readMediaMap(bytes) {
  // Nouveau format : protobuf MediaEntries compressé zstd ; ancien : JSON {"0": "nom.jpg"}.
  if (isZstd(bytes)) {
    const entries = readProto(fzstd.decompress(bytes))[1] || [];
    return entries.map((e, idx) => {
      const m = readProto(e);
      return { name: protoStr(m, 1), zipName: String(m[255] ? m[255][0] : idx) };
    });
  }
  const text = utf8.decode(bytes).trim();
  if (!text) return [];
  return Object.entries(JSON.parse(text)).map(([zipName, name]) => ({ name, zipName }));
}

export async function parsePackage(file) {
  const zip = await JSZip.loadAsync(file);
  const colName = COLLECTION_NAMES.find((n) => zip.file(n));
  if (!colName) throw new Error('Fichier invalide : aucune collection Anki trouvée.');

  const SQL = await getSql();
  const db = new SQL.Database(maybeZstd(await zip.file(colName).async('uint8array')));
  let result;
  try {
    const isV18 = rows(db, "select name from sqlite_master where type='table' and name='notetypes'").length > 0;
    const meta = isV18 ? readV18Models(db) : readLegacyModels(db);
    const notes = rows(db, 'select id, mid, flds, tags from notes').map((n) => ({
      id: n.id, mid: n.mid, fields: n.flds.split('\x1f'),
      tags: n.tags.trim() ? n.tags.trim().split(/\s+/) : [],
    }));
    const cards = rows(db,
      'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odid from cards order by due, ord')
      .map((c) => convertCard(c, meta.crt));
    const usedNt = new Set(notes.map((n) => n.mid));
    const usedDecks = new Set(cards.map((c) => c.did));
    result = {
      notetypes: meta.notetypes.filter((nt) => usedNt.has(nt.id)),
      decks: meta.decks.filter((d) => usedDecks.has(d.id)),
      notes,
      cards,
    };
  } finally {
    db.close();
  }

  const mediaFile = zip.file('media');
  const media = mediaFile ? readMediaMap(await mediaFile.async('uint8array')) : [];
  result.media = media.filter((m) => m.name && zip.file(m.zipName));
  result.loadMedia = async (m) => {
    const bytes = maybeZstd(await zip.file(m.zipName).async('uint8array'));
    return new Blob([bytes], { type: mimeType(m.name) });
  };
  return result;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', webm: 'video/webm', mp4: 'video/mp4', ttf: 'font/ttf', otf: 'font/otf',
  woff: 'font/woff', woff2: 'font/woff2', css: 'text/css',
};

export function mimeType(name) {
  return MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
}
