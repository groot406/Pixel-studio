import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexCommand } from './codex-runtime.mjs';

import { MAX_PROMPT_BYTES, MAX_OUTPUT_BYTES, readPreviewImages, isPixelPrompt, isAssistantPrompt, DATA_INSTRUCTIONS, ASSISTANT_INSTRUCTIONS } from './pixel-request.mjs';
export { MAX_PROMPT_BYTES, MAX_OUTPUT_BYTES } from './pixel-request.mjs';
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9/._:-]{0,159}$/;

export class LocalAIError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'LocalAIError';
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  if (error instanceof LocalAIError) return error;
  return new LocalAIError('CODEX_UNAVAILABLE', 'Local Codex is unavailable. Check that Codex is installed and signed in, then try again.');
}

function codexError(error) {
  // Classify the upstream error without exposing its text, URLs, paths, or tokens.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/rate.?limit|quota|credit|usage.?limit/i.test(message)) {
    return new LocalAIError('USAGE_LIMIT', 'Your Codex account has reached a usage limit. Check your ChatGPT allowance and try again when it resets.', 429);
  }
  if (/unauthori[sz]ed|authentication|sign.?in|log.?in|token.*expir|401/i.test(message)) {
    return new LocalAIError('CODEX_SIGN_IN_REQUIRED', 'Run codex login in Terminal, sign in with ChatGPT, then refresh the connection.', 401);
  }
  if (/context.*(length|window)|too (long|large)|input.*limit/i.test(message)) {
    return new LocalAIError('PROMPT_TOO_LARGE', 'This edit is too large for the selected model. Choose one animation or frame and try again.', 413);
  }
  if (/unable to open database file|failed to initialize.*sqlite|read.only file system|permission denied.*(database|codex)/i.test(message)) {
    return new LocalAIError('CODEX_STORAGE_UNAVAILABLE', 'Codex could not open its local data files. Run codex in Terminal to check its setup and file permissions, then restart Pixel Studio.', 503);
  }
  if (/model.*(not found|unavailable|not supported|access|not permitted)|unsupported.*model/i.test(message)) {
    return new LocalAIError('MODEL_UNAVAILABLE', 'This model is unavailable for your Codex account. Refresh the connection and choose another model.', 400);
  }
  if (/invalid.*(config|params)|unknown.*(field|variant|feature|method)|configuration|invalid value/i.test(message)) {
    return new LocalAIError('CODEX_CONFIGURATION', 'Codex could not start this local session. Update the Codex CLI and check your Codex configuration.', 502);
  }
  if (/network|connect|timed? ?out|fetch|dns|stream.*disconnect|retry/i.test(message)) {
    return new LocalAIError('CODEX_NETWORK', 'Codex could not reach OpenAI or its response was interrupted. Check your connection and try again.', 502);
  }
  return new LocalAIError('CODEX_REQUEST_FAILED', 'Codex could not complete this request. Check your Codex account, or try a smaller edit.');
}

export function codexArguments() {
  const overrides = {
    model_provider: '"openai"',
    approval_policy: '"never"',
    sandbox_mode: '"read-only"',
    web_search: '"disabled"',
    mcp_servers: '{}',
    'apps._default.enabled': 'false',
    'shell_environment_policy.inherit': '"none"',
    'features.shell_tool': 'false',
    'features.unified_exec': 'false',
    'features.shell_snapshot': 'false',
    'features.apps': 'false',
    'features.plugins': 'false',
    'features.remote_plugin': 'false',
    'features.recommended_plugins': 'false',
    'features.multi_agent': 'false',
    'features.hooks': 'false',
    'features.browser_use': 'false',
    'features.computer_use': 'false',
    'features.image_generation': 'false',
    'features.view_image': 'false',
    'features.code_mode': 'false',
    'features.code_mode_host': 'false',
    'features.skill_search': 'false',
    'features.skill_mcp_dependency_install': 'false',
    'features.skip_host_skill_discovery': 'true',
    'features.memories': 'false',
  };
  return ['app-server', '--listen', 'stdio://', ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${value}`])];
}

export function codexEnvironment(environment = process.env) {
  const result = { ...environment };
  // Do not let an inherited API key, access token, or alternate API URL change
  // the selected billing route. Native Codex owns its own stored ChatGPT login.
  for (const key of Object.keys(result)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/i.test(key)) delete result[key];
  }
  return result;
}

export class CodexClient {
  constructor({ spawnProcess = spawn, command, prefixArgs = [], rpcTimeoutMs = 25_000, turnTimeoutMs = 10 * 60_000, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
    this.spawnProcess = spawnProcess;
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = new Set();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.failure = null;
    this.active = null;
  }

  async initialize() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499);
    if (!this.initializing) this.initializing = this.start();
    return this.initializing;
  }

  async start() {
    const command = this.command ?? await resolveCodexCommand();
    const directory = await mkdtemp(join(tmpdir(), 'pixel-studio-codex-'));
    if (this.closed || this.failure) {
      await rm(directory, { recursive: true, force: true });
      throw this.failure || new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499);
    }
    this.directory = directory;
    try {
      this.child = this.spawnProcess(command, [...this.prefixArgs, ...codexArguments()], {
        cwd: directory,
        env: codexEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      });
    } catch (error) {
      throw error.code === 'ENOENT' ? this.missingCodex() : publicError(error);
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.stdin.on('error', () => this.fail(new LocalAIError('CODEX_DISCONNECTED', 'The local Codex process disconnected. Refresh the connection and try again.')));
    this.child.on('error', error => this.fail(error.code === 'ENOENT' ? this.missingCodex() : publicError(error)));
    this.child.on('exit', () => {
      if (!this.closed) this.fail(this.stderr ? codexError({ message: this.stderr }) : new LocalAIError('CODEX_DISCONNECTED', 'The local Codex process stopped before the request completed.'));
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    await this.request('initialize', {
      clientInfo: { name: 'pixel_studio_local', title: 'Pixel Studio Local', version: '1.0.0' },
      capabilities: { experimentalApi: false, explicitGatewayOauth: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  missingCodex() {
    return new LocalAIError('CODEX_NOT_FOUND', 'Codex CLI was not found. Install it with npm install -g @openai/codex, then run codex login and restart Pixel Studio.', 503);
  }

  read(chunk) {
    if (this.closed || this.failure) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(new LocalAIError('OUTPUT_TOO_LARGE', 'Codex returned too much data. Try editing one animation or frame.', 413));
      return;
    }
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.fail(new LocalAIError('CODEX_PROTOCOL_ERROR', 'Codex returned an invalid response. Update the Codex CLI and try again.'));
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(new LocalAIError('CODEX_PROTOCOL_ERROR', 'Codex returned an invalid response. Update the Codex CLI and try again.'));
        return;
      }
      try { this.receive(message); } catch (error) { this.fail(publicError(error)); }
      if (this.failure || this.closed) return;
    }
  }

  receive(message) {
    if ('id' in message && message.method) {
      // No approval, credential request, or client-side tool may be granted by
      // this pixel-data-only client, including methods introduced by new CLIs.
      this.send({ id: message.id, error: { code: -32601, message: 'Pixel Studio does not provide tools, permissions, or credentials.' } });
      this.fail(new LocalAIError('TOOLS_DISABLED', 'This Codex request needs a tool or permission that Pixel Studio does not provide. Ask for a pixel-data edit only.'));
      return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(codexError(message.error));
      else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new LocalAIError('CODEX_PROTOCOL_ERROR', 'Codex returned an incomplete response. Update the CLI and try again.'));
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const listener of this.listeners) listener(message.method, message.params || {});
  }

  send(message) {
    if (this.failure) throw this.failure;
    if (this.closed || !this.child?.stdin?.writable) throw new LocalAIError('CODEX_DISCONNECTED', 'The local Codex process is no longer connected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new LocalAIError('CODEX_TIMEOUT', 'Codex did not respond in time. Refresh the connection and try again.', 504)), this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(publicError(error));
      }
    });
  }

  async getStatus() {
    await this.initialize();
    const result = await this.request('account/read', { refreshToken: false });
    const account = result?.account;
    if (account?.type !== 'chatgpt') {
      const apiKey = account?.type === 'apiKey';
      return {
        connected: false,
        authMode: apiKey ? 'apikey' : null,
        accountLabel: null,
        models: [],
        code: apiKey ? 'CHATGPT_SIGN_IN_REQUIRED' : 'CODEX_SIGN_IN_REQUIRED',
        message: apiKey
          ? 'Codex is signed in with an API key. Run codex login and sign in with ChatGPT to use your plan. Pixel Studio will not use API billing.'
          : 'Run codex login in Terminal, sign in with ChatGPT, then refresh the connection.',
      };
    }
    const models = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 3; page += 1) {
      const catalog = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of Array.isArray(catalog?.data) ? catalog.data : []) {
        const id = model.model || model.id;
        if (model.hidden || typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, name: String(model.displayName || id).slice(0, 120), isDefault: model.isDefault === true, supportsImages: model.inputModalities?.includes('image') ?? true });
      }
      if (!catalog?.nextCursor || catalog.nextCursor === cursor) break;
      cursor = catalog.nextCursor;
    }
    models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    this.availableModels = models;
    const plan = typeof account.planType === 'string' && /^[a-z0-9 _-]{1,40}$/i.test(account.planType) ? account.planType : '';
    return { connected: true, authMode: 'chatgpt', accountLabel: plan ? `ChatGPT · ${plan}` : 'ChatGPT', models: models.map(({ id, name, supportsImages }) => ({ id, name, supportsImages })) };
  }

  async edit({ prompt, model, previews, signal, onEvent = () => {} }) {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      throw new LocalAIError('INVALID_PROMPT', 'Provide a pixel-art edit prompt of at most 2 MB.', 400);
    }
    if (!isPixelPrompt(prompt)) throw new LocalAIError('INVALID_PROMPT', 'Use Pixel Studio’s pixel-data prompt builder for this request.', 400);
    let images;
    try { images=readPreviewImages(previews); }
    catch { throw new LocalAIError('INVALID_PREVIEW', 'Invalid rendered PNG preview.', 400); }
    if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model))) throw new LocalAIError('INVALID_MODEL', 'Choose a model from the local Codex model list.', 400);
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499);
      const status = await this.getStatus();
      if (!status.connected) throw new LocalAIError(status.code, status.message, 401);
      if (model && !this.availableModels.some(entry => entry.id === model)) {
        throw new LocalAIError('INVALID_MODEL', 'This model is not in your local Codex model list. Refresh the connection and select it again.', 400);
      }
      const selectedModel = model || this.availableModels.find(entry => entry.isDefault)?.id;
      if (images.length && this.availableModels.find(entry=>entry.id===selectedModel)?.supportsImages === false) throw new LocalAIError('IMAGE_UNSUPPORTED', 'Choose a model with image support for visual refinement.', 400);
      const imagePaths=[];
      for (const [i,bytes] of images.entries()) {
        const path=join(this.directory,`preview-${i}.png`);
        await writeFile(path,bytes);
        imagePaths.push(path);
      }
      onEvent({ type: 'status', message: 'Preparing the pixel-art edit…' });
      const thread = await this.request('thread/start', {
        ...(selectedModel ? { model: selectedModel } : {}),
        modelProvider: 'openai',
        cwd: this.directory,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: true,
        ...(isAssistantPrompt(prompt) ? ASSISTANT_INSTRUCTIONS : DATA_INSTRUCTIONS),
      });
      const threadId = thread?.thread?.id;
      if (typeof threadId !== 'string') throw new LocalAIError('CODEX_PROTOCOL_ERROR', 'Codex did not create an editing session. Update the CLI and try again.');
      return await this.runTurn({ threadId, prompt, imagePaths, model: selectedModel, onEvent });
    } finally {
      signal?.removeEventListener('abort', abort);
      await this.close();
    }
  }

  async runTurn({ threadId, prompt, imagePaths = [], model, onEvent }) {
    const messages = new Map();
    let outputBytes = 0;
    let settled = false;
    let resolveTurn;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // A notification can reject before turn/start's RPC response is received.
    completion.catch(() => {});
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.listeners.delete(listener);
      this.active = null;
      if (error) rejectTurn(error);
      else resolveTurn({ text, ...(model ? { model } : {}) });
    };
    const timer = setTimeout(() => this.fail(new LocalAIError('GENERATION_TIMEOUT', 'This edit took too long. Try one animation or frame at a time.', 504)), this.turnTimeoutMs);
    const saveMessage = item => {
      if (item?.type !== 'agentMessage' || typeof item.id !== 'string') return;
      const previous = messages.get(item.id) || { text: '', phase: null };
      const next = { text: typeof item.text === 'string' ? item.text : previous.text, phase: item.phase || previous.phase };
      messages.set(item.id, next);
      if ([...messages.values()].reduce((total, entry) => total + Buffer.byteLength(entry.text), 0) > this.maxOutputBytes) {
        this.fail(new LocalAIError('OUTPUT_TOO_LARGE', 'Codex returned too much data. Try one animation or frame at a time.', 413));
      }
    };
    const listener = (method, params) => {
      if (params.threadId !== threadId || settled) return;
      if (method === 'turn/started' && params.turn?.id) this.active.turnId = params.turn.id;
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        if (item?.type && !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'plan'].includes(item.type)) {
          this.fail(new LocalAIError('TOOLS_DISABLED', 'Codex tried to use a tool. Pixel Studio only accepts direct pixel-data responses. Try rephrasing the edit.'));
          return;
        }
        saveMessage(item);
      }
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        outputBytes += Buffer.byteLength(params.delta);
        if (outputBytes > this.maxOutputBytes) {
          this.fail(new LocalAIError('OUTPUT_TOO_LARGE', 'Codex returned too much data. Try one animation or frame at a time.', 413));
          return;
        }
        const itemId = params.itemId || 'response';
        const entry = messages.get(itemId) || { text: '', phase: null };
        entry.text += params.delta;
        messages.set(itemId, entry);
        if (entry.phase !== 'commentary') onEvent({ type: 'delta', text: params.delta });
      }
      if (method === 'error' && params.willRetry !== true) {
        this.fail(codexError(params.error || params));
        return;
      }
      if (method !== 'turn/completed') return;
      const turn = params.turn;
      if (turn?.status !== 'completed') {
        finish(turn?.status === 'interrupted'
          ? new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499)
          : codexError(turn?.error));
        return;
      }
      for (const item of Array.isArray(turn.items) ? turn.items : []) saveMessage(item);
      if (settled) return;
      const candidates = [...messages.values()];
      const final = candidates.filter(entry => entry.phase === 'final_answer').at(-1)
        || candidates.filter(entry => entry.phase !== 'commentary').at(-1);
      if (!final?.text?.trim()) finish(new LocalAIError('EMPTY_RESPONSE', 'Codex completed without returning pixel data. Try a more specific edit.'));
      else finish(null, final.text.trim());
    };
    this.listeners.add(listener);
    this.active = { threadId, turnId: null, reject: error => finish(error) };
    try {
      onEvent({ type: 'status', message: 'Codex is generating pixel data…' });
      const started = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }, ...imagePaths.map(path=>({type:'localImage',path}))],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        serviceTierForTurn: 'default',
      });
      if (this.active && started?.turn?.id) this.active.turnId = started.turn.id;
      return await completion;
    } catch (error) {
      finish(publicError(error));
      return await completion;
    } finally {
      clearTimeout(timer);
      this.listeners.delete(listener);
      this.active = null;
    }
  }

  cancel() {
    if (this.active?.threadId && this.active.turnId && !this.closed && !this.failure) {
      try { this.send({ id: this.nextId++, method: 'turn/interrupt', params: { threadId: this.active.threadId, turnId: this.active.turnId } }); } catch {}
    }
    this.fail(new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499));
  }

  fail(error) {
    if (this.closed || this.failure) return;
    this.failure = publicError(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    this.active?.reject(this.failure);
    void this.close();
  }

  kill(signal) {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { try { child.kill(signal); } catch {} }
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const error = this.failure || new LocalAIError('CANCELLED', 'The Codex request was cancelled.', 499);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.active?.reject(error);
      this.listeners.clear();
      if (this.child) {
        try { this.child.stdin.end(); } catch {}
        this.kill('SIGTERM');
        let hardStop;
        await Promise.race([
          this.exited || Promise.resolve(),
          new Promise(resolve => { hardStop = setTimeout(() => { this.kill('SIGKILL'); resolve(); }, 750); }),
        ]);
        clearTimeout(hardStop);
      }
      if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => {});
      this.buffer = '';
      this.stderr = '';
    })();
    return this.closing;
  }
}
