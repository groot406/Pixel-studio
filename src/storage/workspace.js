/**
 * Device-local project storage. Closing a tab never deletes its saved document. Each save also keeps the previous
 * record as a last good copy, project versions are stored as packed text (domain/versions.js), and journals hold crash-recovery copies.
 */
import { getAnimationLayers, validateProject, MAX_SIZE } from '../domain/project.js';
import { celObjects } from '../domain/objects.js';

const DATABASE_NAME = 'pixel-studio-workspace';
const DATABASE_VERSION = 2;
const VERSION_KINDS = ['auto', 'named', 'before'];
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
    && Number.isInteger(record.width) && record.width >= 1 && record.width <= MAX_SIZE
    && Number.isInteger(record.height) && record.height >= 1 && record.height <= MAX_SIZE
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

/** A version record: listing metadata (see domain/versions.js) plus the packed project as `data`. */
function versionRecord(input) {
  if (!object(input) || !identifier(input.id) || !identifier(input.documentId) || !VERSION_KINDS.includes(input.kind)
    || !Number.isFinite(input.createdAt) || typeof input.data !== 'string' || !input.data) throw new Error('A project version needs an ID, project, kind, time and data.');
  const { data, ...meta } = input;
  return { meta: { ...meta, bytes: data.length }, data: { id: input.id, data } };
}
function journalRecord(input) {
  if (!object(input) || !identifier(input.documentId) || typeof input.data !== 'string' || !Number.isFinite(input.updatedAt)) throw new Error('A recovery journal needs a project ID, time and data.');
  return { ...input };
}
const byNewest = list => list.sort((a, b) => b.createdAt - a.createdAt);

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
export function memoryStore() {
  const documents = new Map(), backups = new Map(), versions = new Map(), versionData = new Map(), journals = new Map();
  let session = null;
  return {
    available: false,
    async loadSession() { return readSession(session); },
    async saveSession(input) { session = sessionRecord(input); },
    async getDocument(id) { return readDocument(documents.get(id)) || readDocument(backups.get(id)); },
    async saveDocument(input) {
      const document = documentRecord(input);
      if (documents.has(document.id)) backups.set(document.id, documents.get(document.id));
      documents.set(document.id, document);
    },
    async listDocuments() { return metadataList([...documents.values()].map(documentMetadata)); },
    async listVersions(documentId) { return byNewest([...versions.values()].filter(v => v.documentId === documentId)); },
    async getVersionData(id) { return versionData.get(id)?.data ?? null; },
    async saveVersion(input) { const { meta, data } = versionRecord(input); versions.set(meta.id, meta); versionData.set(meta.id, data); return meta; },
    async deleteVersions(ids) { for (const id of ids) { versions.delete(id); versionData.delete(id); } },
    async listJournals() { return [...journals.values()]; },
    async saveJournal(input) { const entry = journalRecord(input); journals.set(entry.documentId, entry); },
    async deleteJournal(documentId) { journals.delete(documentId); },
  };
}

/** Resolve only after commit; a request succeeding alone does not mean a save succeeded. */
function transact(database, stores, mode, action) {
  return new Promise((resolve, reject) => {
    let transaction;
    let result, failure;
    try { transaction = database.transaction(stores, mode); }
    catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('The project storage transaction was interrupted.'));
    // Errors thrown in request callbacks would otherwise escape as uncaught exceptions while the transaction commits.
    const fail = error => { failure ??= error; try { transaction.abort(); } catch { reject(error); } };
    try {
      action(transaction, value => { result = value; }, fail);
    } catch (error) {
      fail(error);
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
      return readDocument(await read('projects', id)) || readDocument(await read('backups', id));
    },
    /** One transaction: the previous record becomes the last good copy, then the new one replaces it (all or nothing). */
    async saveDocument(input) {
      const document = documentRecord(input);
      const metadata = documentMetadata(document);
      await transact(database, ['projects', 'metadata', 'backups'], 'readwrite', (transaction, done, fail) => {
        const projects = transaction.objectStore('projects'), previous = projects.get(document.id);
        previous.onsuccess = () => {
          try {
            if (previous.result) transaction.objectStore('backups').put(previous.result);
            projects.put(document);
            transaction.objectStore('metadata').put(metadata);
          } catch (error) { fail(error); }
        };
      });
    },
    async listDocuments() {
      const records = await transact(database, ['metadata'], 'readonly', (transaction, done) => {
        const request = transaction.objectStore('metadata').getAll();
        request.onsuccess = () => done(request.result);
      });
      return metadataList(records);
    },
    async listVersions(documentId) {
      if (!identifier(documentId)) return [];
      return byNewest(await transact(database, ['versions'], 'readonly', (transaction, done) => {
        const request = transaction.objectStore('versions').index('documentId').getAll(documentId);
        request.onsuccess = () => done(request.result);
      }));
    },
    async getVersionData(id) { return identifier(id) ? (await read('versionData', id))?.data ?? null : null; },
    async saveVersion(input) {
      const { meta, data } = versionRecord(input);
      await transact(database, ['versions', 'versionData'], 'readwrite', transaction => {
        transaction.objectStore('versionData').put(data);
        transaction.objectStore('versions').put(meta);
      });
      return meta;
    },
    async deleteVersions(ids) {
      if (!ids.length) return;
      await transact(database, ['versions', 'versionData'], 'readwrite', transaction => {
        for (const id of ids) { transaction.objectStore('versions').delete(id); transaction.objectStore('versionData').delete(id); }
      });
    },
    async listJournals() {
      return transact(database, ['journal'], 'readonly', (transaction, done) => {
        const request = transaction.objectStore('journal').getAll();
        request.onsuccess = () => done(request.result);
      });
    },
    async saveJournal(input) {
      const entry = journalRecord(input);
      await transact(database, ['journal'], 'readwrite', transaction => transaction.objectStore('journal').put(entry));
    },
    async deleteJournal(documentId) {
      await transact(database, ['journal'], 'readwrite', transaction => transaction.objectStore('journal').delete(documentId));
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
        if (!database.objectStoreNames.contains('backups')) database.createObjectStore('backups', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('versions')) database.createObjectStore('versions', { keyPath: 'id' }).createIndex('documentId', 'documentId');
        if (!database.objectStoreNames.contains('versionData')) database.createObjectStore('versionData', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('journal')) database.createObjectStore('journal', { keyPath: 'documentId' });
      } catch { request.transaction.abort(); }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
  return database ? persistentStore(database) : memoryStore();
}
