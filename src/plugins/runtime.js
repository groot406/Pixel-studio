/**
 * Plugin registry — installed plugins, their workers and what they registered. No DOM: the browser passes a Web Worker
 * spawner (worker-host.js) and an IndexedDB store (store.js); tests pass worker_threads and an in-memory store.
 * A plugin is loaded (and its registrations validated) before it is saved, so a broken file never gets installed.
 */
import { PluginHost } from './protocol.js';
import { parsePluginSource, validateRegistrations, compareVersions } from './validate.js';

const EMPTY = Object.freeze({ commands: [], effects: [], promptSkills: [], palettes: [] });

export function memoryStore(initial = []) {
  const records = new Map(initial.map(r => [r.id, r]));
  return {
    async list() { return [...records.values()].map(r => ({ ...r })); },
    async put(record) { records.set(record.id, { ...record }); },
    async remove(id) { records.delete(id); },
  };
}

export class PluginRegistry {
  constructor({ store, spawn, platform = 'browser', runTimeout, loadTimeout, onChange = () => {}, onLog = () => {} }) {
    Object.assign(this, { store, spawn, platform, runTimeout, loadTimeout, onChange, onLog, entries: new Map() });
  }

  /** Read installed plugins and start the enabled ones; per-plugin failures are kept as `error`, never thrown. */
  async load() {
    let records = [];
    try { records = await this.store.list(); } catch (error) { this.storeError = error.message; }
    await Promise.all(records.map(async record => {
      try {
        const { manifest, code } = parsePluginSource(record.source);
        const entry = this.#entry(record, manifest, code);
        if (entry.enabled) await this.#start(entry).catch(() => {});
      } catch (error) {
        this.entries.set(record.id, { id: record.id, manifest: { id: record.id, name: record.id, version: '?', description: '', author: '', permissions: [] }, record, enabled: false, status: 'error', error: error.message, registrations: EMPTY });
      }
    }));
    this.onChange();
  }

  #entry(record, manifest, code) {
    const entry = { id: manifest.id, manifest, code, record, enabled: record.enabled !== false, status: record.enabled === false ? 'disabled' : 'loading', error: '', registrations: EMPTY, host: null };
    this.entries.get(manifest.id)?.host?.stop();
    this.entries.set(manifest.id, entry);
    return entry;
  }

  #host(code, id) {
    return new PluginHost(code, this.spawn, { platform: this.platform, runTimeout: this.runTimeout, loadTimeout: this.loadTimeout, onLog: message => this.onLog(id, message) });
  }

  async #start(entry) {
    entry.status = 'loading';
    entry.host?.stop();
    entry.host = this.#host(entry.code, entry.id);
    try {
      entry.registrations = validateRegistrations(await entry.host.start(), entry.manifest);
      entry.status = 'ready'; entry.error = '';
    } catch (error) {
      entry.host.stop(); entry.host = null;
      entry.registrations = EMPTY; entry.status = 'error'; entry.error = error.message;
      throw error;
    }
  }

  /** Describe a plugin file without installing it: { manifest, existing (installed version or null), change }. */
  inspect(source) {
    const { manifest } = parsePluginSource(source), existing = this.entries.get(manifest.id)?.manifest.version ?? null;
    const order = existing && existing !== '?' ? compareVersions(manifest.version, existing) : 1;
    return { manifest, existing, change: !existing ? 'install' : order > 0 ? 'update' : order < 0 ? 'downgrade' : 'reinstall' };
  }

  /** Test-load `source` in a fresh worker, then save and enable it (replacing an older version). */
  async install(source, origin = 'file') {
    const { manifest, code } = parsePluginSource(source), info = this.inspect(source);
    const probe = this.#host(code, manifest.id);
    let registrations;
    try { registrations = validateRegistrations(await probe.start(), manifest); }
    catch (error) { probe.stop(); throw error; }
    const now = new Date().toISOString(), previous = this.entries.get(manifest.id)?.record;
    const record = { id: manifest.id, source, origin, enabled: true, installedAt: previous?.installedAt || now, updatedAt: now };
    await this.store.put(record);
    const entry = this.#entry(record, manifest, code);
    Object.assign(entry, { registrations, host: probe, status: 'ready' });
    this.onChange();
    return { manifest, change: info.change, registrations: entry.registrations };
  }

  async setEnabled(id, enabled) {
    const entry = this.entries.get(id);
    if (!entry?.code) throw new Error('This plugin is not installed correctly; uninstall it.');
    entry.record = { ...entry.record, enabled };
    await this.store.put(entry.record);
    entry.enabled = enabled;
    if (enabled) await this.#start(entry).catch(() => {});
    else { entry.host?.stop(); entry.host = null; entry.status = 'disabled'; entry.error = ''; entry.registrations = EMPTY; }
    this.onChange();
  }

  async uninstall(id) {
    this.entries.get(id)?.host?.stop();
    this.entries.delete(id);
    await this.store.remove(id);
    this.onChange();
  }

  list() {
    return [...this.entries.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map(e => ({
      id: e.id, manifest: e.manifest, enabled: e.enabled, status: e.status, error: e.error, origin: e.record?.origin, updatedAt: e.record?.updatedAt, registrations: e.registrations,
    }));
  }

  #ready() { return [...this.entries.values()].filter(e => e.enabled && e.status === 'ready'); }

  /** Commands and effects of enabled plugins: [{ key, pluginId, pluginName, kind, id, scope, title, description, params }]. */
  actions() {
    return this.#ready().flatMap(e => [...e.registrations.effects, ...e.registrations.commands].map(a => ({ ...a, key: `${e.id}/${a.id}`, pluginId: e.id, pluginName: e.manifest.name })));
  }
  promptSkills() { return this.#ready().flatMap(e => e.registrations.promptSkills.map(s => ({ ...s, key: `${e.id}/${s.id}`, pluginId: e.id, pluginName: e.manifest.name }))); }
  palettes() { return this.#ready().flatMap(e => e.registrations.palettes.map(p => ({ ...p, key: `${e.id}/${p.name}`, pluginId: e.id, pluginName: e.manifest.name }))); }

  /** Run action `actionId` of plugin `pluginId` with plain-data `context`; resolves to the raw (unvalidated) result. */
  async run(pluginId, actionId, context, transfer) {
    const entry = this.entries.get(pluginId);
    if (!entry || !entry.enabled) throw new Error('This plugin is not enabled.');
    if (!entry.host) await this.#start(entry);
    try { return await entry.host.run(actionId, context, transfer); }
    catch (error) {
      if (!entry.host?.running) { entry.host = null; entry.status = 'ready'; entry.error = `Last run: ${error.message}`; this.onChange(); }
      throw error;
    }
  }

  stopAll() { for (const entry of this.entries.values()) { entry.host?.stop(); entry.host = null; } }
}
