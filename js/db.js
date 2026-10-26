// Petit utilitaire IndexedDB : toutes les données restent sur l'appareil.

const DB_NAME = 'moto-flashcards';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('decks', { keyPath: 'id' });
      db.createObjectStore('notetypes', { keyPath: 'id' });
      db.createObjectStore('notes', { keyPath: 'id' });
      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('did', 'did');
      cards.createIndex('nid', 'nid');
      db.createObjectStore('media', { keyPath: 'name' });
      db.createObjectStore('revlog', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return promisify((await store(name)).getAll());
}

export async function get(name, key) {
  return promisify((await store(name)).get(key));
}

export async function getAllByIndex(name, index, key) {
  return promisify((await store(name)).index(index).getAll(key));
}

export async function put(name, value, key) {
  return promisify((await store(name, 'readwrite')).put(value, key));
}

export async function del(name, key) {
  return promisify((await store(name, 'readwrite')).delete(key));
}

// Écrit plusieurs objets dans une seule transaction.
export async function putMany(name, values) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteMany(name, keys) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const k of keys) s.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllKeys(name) {
  return promisify((await store(name)).getAllKeys());
}

export async function clearAll() {
  const db = await openDb();
  const names = [...db.objectStoreNames];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
