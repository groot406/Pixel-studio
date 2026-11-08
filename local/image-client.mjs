// Pixel Studio Local's image-model proxy. API keys come from the environment (OPENAI_API_KEY,
// GEMINI_API_KEY or GOOGLE_API_KEY) or ~/.pixelstudio/keys.json ({"openai": "...", "gemini": "..."})
// and never reach the browser. Upstream errors are classified; their text is never forwarded.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalAIError } from './codex-client.mjs';
import { IMAGE_PROVIDERS, IMAGE_ERROR_MESSAGES, ImageApiError, MAX_IMAGE_PROMPT, MAX_VARIATIONS, isImageModel, requestImages } from '../src/features/ai/image-api.js';

export const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BODY_BYTES = Math.ceil(MAX_REFERENCE_BYTES * 4 / 3) + 64 * 1024;
const FIELDS = ['provider', 'model', 'prompt', 'size', 'reference', 'n', 'background', 'quality'];
const STATUS = { auth: 401, quota: 429, rejected: 422, model: 400, 'no-image': 502, network: 502, timeout: 504, failed: 502 };
const CODES = { auth: 'IMAGE_KEY_INVALID', quota: 'IMAGE_USAGE_LIMIT', rejected: 'IMAGE_REJECTED', model: 'IMAGE_MODEL_UNAVAILABLE', 'no-image': 'IMAGE_NO_RESULT', network: 'IMAGE_NETWORK', timeout: 'IMAGE_TIMEOUT', failed: 'IMAGE_REQUEST_FAILED' };

export const defaultKeysFile = () => join(homedir(), '.pixelstudio', 'keys.json');

/** Keys from the environment first, then the optional keys file. Missing or unreadable files mean "no key". */
export async function readImageKeys({ env = process.env, keysFile = defaultKeysFile() } = {}) {
  let file = {};
  if (keysFile) {
    try { const parsed = JSON.parse(await readFile(keysFile, 'utf8')); if (parsed && typeof parsed === 'object') file = parsed; } catch { /* optional */ }
  }
  const pick = (...values) => values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
  return {
    openai: pick(env.OPENAI_API_KEY, file.openai, file.OPENAI_API_KEY),
    gemini: pick(env.GEMINI_API_KEY, env.GOOGLE_API_KEY, file.gemini, file.GEMINI_API_KEY, file.GOOGLE_API_KEY),
  };
}

function isPng(base64) {
  return typeof base64 === 'string' && base64.length > 16 && base64.length <= Math.ceil(MAX_REFERENCE_BYTES * 4 / 3)
    && /^[A-Za-z0-9+/]+={0,2}$/.test(base64) && base64.startsWith('iVBORw0KGgo');
}

/** Validate a parsed generate body; throws LocalAIError(400) on anything unexpected. */
export function validateImageRequest(body) {
  const invalid = message => new LocalAIError('INVALID_REQUEST', message, 400);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !FIELDS.includes(key))) throw invalid('This endpoint accepts provider, model, prompt, n and an optional PNG reference.');
  if (!(body.provider in IMAGE_PROVIDERS)) throw invalid('Choose OpenAI or Gemini.');
  const model = body.model ?? IMAGE_PROVIDERS[body.provider].defaultModel;
  if (!isImageModel(body.provider, model)) throw new LocalAIError('INVALID_MODEL', 'Choose an image model from the list.', 400);
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_IMAGE_PROMPT) throw invalid(`Describe the image in at most ${MAX_IMAGE_PROMPT} characters.`);
  if (body.size !== undefined && body.size !== '1024x1024') throw invalid('Images are generated at 1024 × 1024.');
  const n = body.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_VARIATIONS) throw invalid(`Ask for 1–${MAX_VARIATIONS} variations.`);
  if (body.reference !== undefined && !isPng(body.reference)) throw invalid('The reference must be a PNG of at most 4 MB.');
  if (body.background !== undefined && !['transparent', 'magenta', 'white'].includes(body.background)) throw invalid('Unknown background.');
  if (body.quality !== undefined && !['low', 'medium', 'high'].includes(body.quality)) throw invalid('Unknown quality.');
  return { provider: body.provider, model, prompt: body.prompt, n, reference: body.reference, background: body.background, quality: body.quality };
}

/** Read and validate a JSON generate request with a strict size limit. */
export async function readImageRequest(request) {
  const tooLarge = () => new LocalAIError('BODY_TOO_LARGE', 'This image request is too large. Use a smaller reference.', 413);
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_IMAGE_BODY_BYTES) throw tooLarge();
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new LocalAIError('INVALID_CONTENT_TYPE', 'Send this request as JSON.', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_IMAGE_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LocalAIError('INVALID_JSON', 'The request could not be read. Refresh Pixel Studio and try again.', 400); }
  return validateImageRequest(body);
}

export function imageError(error) {
  if (error instanceof LocalAIError) return error;
  const kind = error instanceof ImageApiError ? error.kind : 'failed';
  return new LocalAIError(CODES[kind] || CODES.failed, IMAGE_ERROR_MESSAGES[kind] || IMAGE_ERROR_MESSAGES.failed, STATUS[kind] || 502);
}

/** The default client; `fetchImpl` and `keys` are test seams. */
export function createImageClient({ env = process.env, keysFile = defaultKeysFile(), fetchImpl = globalThis.fetch, timeoutMs = 150_000, keys } = {}) {
  const loadKeys = () => keys ? Promise.resolve(keys) : readImageKeys({ env, keysFile });
  return {
    async status() {
      const found = await loadKeys();
      return Object.fromEntries(Object.entries(IMAGE_PROVIDERS).map(([id, p]) => [id, { label: p.label, available: !!found[id], models: p.models, defaultModel: p.defaultModel }]));
    },
    async generate({ signal, ...options }) {
      const key = (await loadKeys())[options.provider];
      if (!key) throw new LocalAIError('IMAGE_KEY_MISSING', `Set ${options.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} before starting Pixel Studio Local, or add it to ~/.pixelstudio/keys.json.`, 400);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const forward = () => controller.abort();
      signal?.addEventListener('abort', forward, { once: true });
      try {
        const images = await requestImages({ ...options, key }, { fetchImpl, signal: controller.signal });
        return { images };
      } catch (error) {
        if (signal?.aborted) throw new LocalAIError('CANCELLED', 'The image request was cancelled.', 499);
        throw imageError(error);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); }
    },
  };
}
