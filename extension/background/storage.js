// Persistence.
//
// Two stores with different jobs:
//
//   storage.local  small settings (whitelist, custom rules, counters). Cheap to
//                  read, survives restarts, syncs nothing.
//   IndexedDB      the compiled filter index, ~10MB. Written once per refresh,
//                  read on every event-page wake-up.
//
// The index is stored as the live object graph. Structured clone handles Maps,
// Sets and TypedArrays natively, so there is no serialisation format to write
// or keep in step with the compiler — which also means no chance of the two
// drifting apart.

const DB_NAME = 'sift-adblocker';
const DB_VERSION = 1;
const STORE = 'index';
const INDEX_KEY = 'compiled';

export const DEFAULT_SETTINGS = {
  enabled: true,
  // Hostnames where blocking is off. The popup's per-site toggle and the
  // options page's whitelist are the same list, deliberately: two independent
  // ways to say "leave this site alone" would only ever confuse.
  disabledSites: [],
  customRules: '',
  totalBlocked: 0,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  await browser.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Read the cached compiled index, or null if there isn't a usable one. */
export async function loadIndex() {
  try {
    const db = await openDB();
    const value = await tx(db, 'readonly', (store) => store.get(INDEX_KEY));
    return value ?? null;
  } catch (err) {
    console.warn('[sift] could not read cached index:', err);
    return null;
  }
}

export async function saveIndex(record) {
  try {
    const db = await openDB();
    await tx(db, 'readwrite', (store) => store.put(record, INDEX_KEY));
    return true;
  } catch (err) {
    // A failed cache write is survivable: the index is already in memory and
    // will simply be recompiled on the next cold start.
    console.warn('[sift] could not cache index:', err);
    return false;
  }
}

export async function clearIndex() {
  try {
    const db = await openDB();
    await tx(db, 'readwrite', (store) => store.delete(INDEX_KEY));
  } catch (err) {
    console.warn('[sift] could not clear cached index:', err);
  }
}
