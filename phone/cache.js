// Blobs keyed by sha. IndexedDB can be missing or refuse (private mode); the page then works from memory and fetches again next time.
const memory = new Map();
let db = null;

export async function openCache() {
  db = await new Promise((resolve) => {
    try {
      const req = indexedDB.open('noesis', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cached(sha, load) {
  if (memory.has(sha)) return memory.get(sha);
  let value = db ? await request((s) => s.get(sha), 'readonly') : undefined;
  if (value === undefined) {
    value = await load();
    if (db) await request((s) => s.put(value, sha), 'readwrite');
  }
  memory.set(sha, value);
  return value;
}

function request(op, mode) {
  return new Promise((resolve) => {
    try {
      const req = op(db.transaction('blobs', mode).objectStore('blobs'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}
