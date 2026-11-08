// Request building and response parsing for image models, shared by the browser ("bring your own key")
// and Pixel Studio Local's proxy (local/image-client.mjs). Uses only fetch, FormData, Blob and atob,
// which exist in browsers and Node 20.

export const IMAGE_PROVIDERS = {
  openai: { label: 'OpenAI', models: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'], defaultModel: 'gpt-image-1', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'], defaultModel: 'gemini-2.5-flash-image', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
};

const MODEL_PATTERN = { openai: /^(gpt-image-[a-z0-9.-]{1,40}|dall-e-[23])$/, gemini: /^gemini-[a-z0-9.-]{1,60}$/ };
export const MAX_IMAGE_PROMPT = 4000;
export const MAX_VARIATIONS = 4;

export function isImageModel(provider, model) {
  return !!MODEL_PATTERN[provider] && typeof model === 'string' && MODEL_PATTERN[provider].test(model);
}

/** An upstream failure, classified so callers can show a safe message without echoing the upstream body. */
export class ImageApiError extends Error {
  constructor(kind, status = 0) { super(kind); this.name = 'ImageApiError'; this.kind = kind; this.status = status; }
}

export const IMAGE_ERROR_MESSAGES = {
  auth: 'The image service rejected the API key. Check that it is correct and has image access.',
  quota: 'The image service reports a rate or usage limit. Wait a moment or check your billing, then try again.',
  rejected: 'The image service declined this prompt (safety filter). Rephrase the description and try again.',
  model: 'This model is not available for your key. Choose another model.',
  'no-image': 'The image service answered without an image. Try again or rephrase the description.',
  network: 'Could not reach the image service. Check your connection and try again.',
  timeout: 'The image service took too long. Try fewer variations or a lower quality.',
  failed: 'The image service could not create this image. Try again in a moment.',
};

function base64Bytes(base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The HTTP requests for one generation: [{ url, init }]. OpenAI returns all variations in one call;
 * Gemini makes one image per call, so it gets `n` identical requests.
 * options: { provider, model, prompt, n, reference (base64 PNG), background ('transparent'|other), quality, key }
 */
export function imageRequests({ provider, model, prompt, n = 1, reference, background, quality, key }) {
  const count = Math.max(1, Math.min(MAX_VARIATIONS, Math.round(n) || 1));
  if (provider === 'openai') {
    const headers = { Authorization: `Bearer ${key}` };
    const fields = { model, prompt, n: String(count), size: '1024x1024' };
    if (background === 'transparent') fields.background = 'transparent';
    if (['low', 'medium', 'high'].includes(quality)) fields.quality = quality;
    if (reference) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      form.append('image', new Blob([base64Bytes(reference)], { type: 'image/png' }), 'reference.png');
      return [{ url: 'https://api.openai.com/v1/images/edits', init: { method: 'POST', headers, body: form } }];
    }
    const body = { ...fields, n: count };
    return [{ url: 'https://api.openai.com/v1/images/generations', init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }];
  }
  if (provider === 'gemini') {
    const parts = [{ text: prompt }];
    if (reference) parts.push({ inline_data: { mime_type: 'image/png', data: reference } });
    const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } } });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return Array.from({ length: count }, () => ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body } }));
  }
  throw new ImageApiError('model');
}

function classify(status, text) {
  if (status === 401 || status === 403) return /model|not.?found|permission.*model/i.test(text) && status === 403 ? 'model' : 'auth';
  if (status === 429) return 'quota';
  if (/moderation|safety|content.?policy|blocked|prohibited/i.test(text)) return 'rejected';
  if (status === 404 || /model.*(not|unsupported|invalid)|unknown model/i.test(text)) return 'model';
  if (/api.?key|invalid.*key|key.*invalid/i.test(text)) return 'auth';
  if (/billing|quota|insufficient/i.test(text)) return 'quota';
  return 'failed';
}

/** Base64 PNG/JPEG/WebP images from one response; throws ImageApiError. */
export async function readImageResponse(provider, response) {
  const text = await response.text();
  if (!response.ok) throw new ImageApiError(classify(response.status, text), response.status);
  let json;
  try { json = JSON.parse(text); } catch { throw new ImageApiError('failed', response.status); }
  if (provider === 'openai') {
    const images = (json.data || []).map(item => item?.b64_json).filter(v => typeof v === 'string' && v);
    if (!images.length) throw new ImageApiError('no-image');
    return images;
  }
  const candidate = json.candidates?.[0];
  const images = (candidate?.content?.parts || [])
    .filter(part => !part.thought)
    .map(part => (part.inline_data || part.inlineData)?.data)
    .filter(v => typeof v === 'string' && v);
  if (!images.length) {
    const reason = `${candidate?.finishReason || ''} ${json.promptFeedback?.blockReason || ''}`;
    throw new ImageApiError(/SAFETY|PROHIBITED|BLOCK|RECITATION|IMAGE_SAFETY/i.test(reason) ? 'rejected' : 'no-image');
  }
  return images.slice(-1);
}

/**
 * Run all requests with `fetchImpl` and collect the images. Gemini calls run in parallel; any image is kept even
 * if some calls fail, otherwise the first error is thrown.
 */
export async function requestImages(options, { fetchImpl = fetch, signal } = {}) {
  const results = await Promise.allSettled(imageRequests(options).map(async ({ url, init }) => {
    let response;
    try { response = await fetchImpl(url, { ...init, signal }); }
    catch (error) { throw new ImageApiError(signal?.aborted ? 'timeout' : 'network'); }
    return readImageResponse(options.provider, response);
  }));
  const images = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  if (images.length) return images.slice(0, MAX_VARIATIONS);
  const error = results.find(r => r.status === 'rejected')?.reason;
  throw error instanceof ImageApiError ? error : new ImageApiError('failed');
}
