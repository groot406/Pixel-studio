/**
 * Installed plugins on this device: IndexedDB (database “pixel-studio-plugins”), falling back to localStorage when
 * IndexedDB is unavailable (private windows in some browsers). Records: { id, source, origin, enabled, installedAt, updatedAt }.
 */
const DB = 'pixel-studio-plugins', STORE = 'plugins', FALLBACK_KEY = 'pixel-studio.plugins';

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB is unavailable.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
  });
}
function call(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save the plugin.'));
  });
}

function localStore() {
  const read = () => { try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]'); } catch { return []; } };
  const write = list => {
    try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(list)); }
    catch { throw new Error('This browser’s storage is full; uninstall a plugin first.'); }
  };
  return {
    kind: 'localStorage',
    async list() { return read(); },
    async put(record) { write([...read().filter(r => r.id !== record.id), record]); },
    async remove(id) { write(read().filter(r => r.id !== id)); },
  };
}

/** Resolve to a store { kind, list(), put(record), remove(id) }. */
export async function openPluginStore() {
  let db;
  try { db = await openDatabase(); } catch { return localStore(); }
  return {
    kind: 'indexedDB',
    list: () => call(db, 'readonly', s => s.getAll()),
    put: record => call(db, 'readwrite', s => s.put(record)),
    remove: id => call(db, 'readwrite', s => s.delete(id)),
  };
}
