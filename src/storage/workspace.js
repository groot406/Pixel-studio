/** Device-local project storage. Closing a tab never deletes its saved document. */
import { getAnimationLayers, validateProject } from '../domain/project.js';
import { celObjects } from '../domain/objects.js';

const DATABASE_NAME = 'pixel-studio-workspace';
const DATABASE_VERSION = 1;
const SESSION_KEY = 'workspace';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length <= 200 && value.trim().length > 0;

function documentRecord(input) {
  if (!object(input) || !identifier(input.id)) throw new Error('A saved project needs a valid document ID.');
  const project = validateProject(input.project);
  const animation = project.animations.find(item => item.id === input.animationId) || project.animations[0];
  const frame = animation.frames.find(item => item.id === input.frameId) || animation.frames[0];
  const layers = [...getAnimationLayers(project,animation,frame)].reverse();
  const layer = layers.find(item => item.id === input.layerId)
    || layers.find(item => item.visible && !item.locked)
    || layers.find(item => item.visible)
    || layers[0];
  const selected=input.objectSelection;
  const objectSelection=object(selected) && selected.layerId===layer.id && typeof selected.key==='string'
    && (selected.key==='@group' || celObjects(frame.cels.find(c=>c.layerId===layer.id)).some(n=>n.key===selected.key))
    ? {layerId:layer.id,key:selected.key} : null;
  return {
    id: input.id, project, animationId: animation.id, frameId: frame.id, layerId: layer.id,
    objectSelection,
    updatedAt: Number.isFinite(input.updatedAt) && input.updatedAt >= 0 ? input.updatedAt : Date.now(),
  };
}

function documentMetadata(document) {
  const { id, project, updatedAt } = document;
  return {
    id, name: project.name, width: project.width, height: project.height,
    frameCount: project.animations.reduce((count, animation) => count + animation.frames.length, 0),
    animationCount: project.animations.length, updatedAt,
  };
}

function metadataList(records) {
  return records.filter(record => object(record) && identifier(record.id)
    && typeof record.name === 'string' && record.name.trim() && record.name.length <= 120
    && Number.isInteger(record.width) && record.width >= 1 && record.width <= 128
    && Number.isInteger(record.height) && record.height >= 1 && record.height <= 128
    && Number.isInteger(record.frameCount) && record.frameCount >= 1 && record.frameCount <= 1024
    && Number.isInteger(record.animationCount) && record.animationCount >= 1 && record.animationCount <= 100
    && Number.isFinite(record.updatedAt) && record.updatedAt >= 0)
    .map(({ id, name, width, height, frameCount, animationCount, updatedAt }) => ({ id, name, width, height, frameCount, animationCount, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function sessionRecord(input) {
  if (!object(input) || !Array.isArray(input.openIds) || !input.openIds.every(identifier)) {
    throw new Error('A workspace session needs a list of valid project IDs.');
  }
  const openIds = [...new Set(input.openIds)];
  const result = { openIds, activeId: openIds.includes(input.activeId) ? input.activeId : openIds[0] || null };
  if (object(input.panels)) result.panels = { tools: input.panels.tools === true, details: input.panels.details === true };
  if (object(input.panelSections)) {
    result.panelSections = {};
    for (const [key, value] of Object.entries(input.panelSections)) {
      if (/^[a-z][a-z0-9-]{0,39}$/i.test(key) && typeof value === 'boolean') result.panelSections[key] = value;
    }
  }
  return result;
}

function readDocument(record) {
  if (!record) return null;
  try { return documentRecord(record); }
  catch { return null; } // One corrupt file must not prevent other tabs from opening.
}

function readSession(record) {
  if (!record) return null;
  try { return sessionRecord(record); }
  catch { return null; }
}

/** This fallback stays usable without claiming that its data survives a reload. */
function memoryStore() {
  const documents = new Map();
  let session = null;
  return {
    available: false,
    async loadSession() { return readSession(session); },
    async saveSession(input) { session = sessionRecord(input); },
    async getDocument(id) { return readDocument(documents.get(id)); },
    async saveDocument(input) {
      const document = documentRecord(input);
      documents.set(document.id, document);
    },
    async listDocuments() { return metadataList([...documents.values()].map(documentMetadata)); },
  };
}

/** Resolve only after commit; a request succeeding alone does not mean a save succeeded. */
function transact(database, stores, mode, action) {
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    try { transaction = database.transaction(stores, mode); }
    catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('The project storage transaction was interrupted.'));
    try {
      action(transaction, value => { result = value; });
    } catch (error) {
      try { transaction.abort(); } catch { /* The transaction may have already finished. */ }
      reject(error);
    }
  });
}

function persistentStore(database) {
  let available = true;
  database.onversionchange = () => { available = false; database.close(); };
  database.onclose = () => { available = false; };
  const read = (store, key) => transact(database, [store], 'readonly', (transaction, done) => {
    const request = transaction.objectStore(store).get(key);
    request.onsuccess = () => done(request.result);
  });
  return {
    get available() { return available; },
    async loadSession() { return readSession(await read('session', SESSION_KEY)); },
    async saveSession(input) {
      const session = sessionRecord(input);
      await transact(database, ['session'], 'readwrite', transaction => transaction.objectStore('session').put(session, SESSION_KEY));
    },
    async getDocument(id) {
      if (!identifier(id)) return null;
      return readDocument(await read('projects', id));
    },
    async saveDocument(input) {
      const document = documentRecord(input);
      const metadata = documentMetadata(document);
      await transact(database, ['projects', 'metadata'], 'readwrite', transaction => {
        transaction.objectStore('projects').put(document);
        transaction.objectStore('metadata').put(metadata);
      });
    },
    async listDocuments() {
      const records = await transact(database, ['metadata'], 'readonly', (transaction, done) => {
        const request = transaction.objectStore('metadata').getAll();
        request.onsuccess = () => done(request.result);
      });
      return metadataList(records);
    },
  };
}

/**
 * Open the workspace once per page. Callers own save ordering and legacy migration.
 * Document dates are epoch milliseconds; project, navigation, and panel state are cloned.
 * Storage errors reject the operation. `available === false` means export is needed
 * for a durable copy, including when a version change closes this connection.
 */
export async function openProjectStore() {
  let indexedDB;
  try { indexedDB = globalThis.indexedDB; }
  catch { return memoryStore(); }
  if (!indexedDB) return memoryStore();
  const database = await new Promise(resolve => {
    let request;
    let settled = false;
    const finish = value => {
      if (settled) { value?.close(); return; }
      settled = true;
      resolve(value);
    };
    try { request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION); }
    catch { finish(null); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      try {
        if (!database.objectStoreNames.contains('projects')) database.createObjectStore('projects', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('metadata')) database.createObjectStore('metadata', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('session')) database.createObjectStore('session');
      } catch { request.transaction.abort(); }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
  return database ? persistentStore(database) : memoryStore();
}
