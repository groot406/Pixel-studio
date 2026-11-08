// Hosted AI for Pixel Studio Cloud: OpenAI chat completions (streamed) with the server's key, replacing local Codex,
// plus image generation through the shared image-api module. Upstream error bodies are never forwarded.
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from '../src/features/cloud/plans.js';
import { DATA_INSTRUCTIONS, ASSISTANT_INSTRUCTIONS, MAX_OUTPUT_BYTES, isAssistantPrompt } from '../local/pixel-request.mjs';
import { requestImages } from '../src/features/ai/image-api.js';
import { imageError } from '../local/image-client.mjs';
import { CloudError } from './store.mjs';

const estimateTokens = text => Math.ceil(Buffer.byteLength(String(text || '')) / 4);

function upstreamError(status) {
  if (status === 429) return new CloudError('AI_BUSY', 'The AI service is busy right now. Try again in a minute; no credits were used.', 503);
  if (status === 400) return new CloudError('PROMPT_TOO_LARGE', 'This request is too large for the model. Choose one animation or frame and try again.', 413);
  return new CloudError('AI_UNAVAILABLE', 'The AI service could not answer. Try again in a moment; no credits were used.', 502);
}

export const chatModels = () => Object.entries(CHAT_MODELS).map(([id, m]) => ({ id, name: m.name, supportsImages: m.supportsImages }));

/**
 * Streams one chat completion. Calls onEvent({type:'delta', text}) as text arrives and resolves to
 * { text, model, inputTokens, outputTokens } (token counts estimated when the stream ends early).
 */
export async function chatEdit({ key, prompt, model = DEFAULT_CHAT_MODEL, previews = [], signal, onEvent = () => {}, fetchImpl = globalThis.fetch }) {
  if (!key) throw new CloudError('AI_NOT_CONFIGURED', 'AI is not set up on this server yet.', 503);
  if (!CHAT_MODELS[model]) throw new CloudError('INVALID_MODEL', 'Choose one of the listed models.', 400);
  const instructions = isAssistantPrompt(prompt) ? ASSISTANT_INSTRUCTIONS : DATA_INSTRUCTIONS;
  const body = {
    model, stream: true, stream_options: { include_usage: true },
    ...(isAssistantPrompt(prompt) ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: `${instructions.baseInstructions}\n\n${instructions.developerInstructions}` },
      { role: 'user', content: [{ type: 'text', text: prompt }, ...previews.map(url => ({ type: 'image_url', image_url: { url } }))] },
    ],
  };
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw new CloudError('CANCELLED', 'The request was cancelled.', 499);
    throw new CloudError('AI_UNAVAILABLE', 'The AI service could not be reached. Try again in a moment; no credits were used.', 502);
  }
  if (!response.ok || !response.body) throw upstreamError(response.status);
  let text = '', usage = null, buffer = '';
  const decoder = new TextDecoder();
  const result = () => ({ text, model, inputTokens: usage?.prompt_tokens ?? estimateTokens(prompt) + previews.length * 800, outputTokens: usage?.completion_tokens ?? estimateTokens(text) });
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw Object.assign(new CloudError('OUTPUT_TOO_LARGE', 'This edit is too large. Try one animation or frame at a time.', 413), { partial: result() });
          onEvent({ type: 'delta', text: delta });
        }
      }
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw Object.assign(signal?.aborted ? new CloudError('CANCELLED', 'The request was cancelled.', 499) : new CloudError('AI_UNAVAILABLE', 'The AI answer was interrupted. Try again.', 502), { partial: result() });
  }
  if (!text.trim()) throw Object.assign(new CloudError('AI_EMPTY', 'The AI answered without text. Try again.', 502), { partial: result() });
  return result();
}

/** Server-side image keys (OPENAI_API_KEY, GEMINI_API_KEY) → { images } using the shared request builder. */
export async function generateImages({ keys, signal, fetchImpl = globalThis.fetch, timeoutMs = 150_000, ...options }) {
  const key = keys[options.provider];
  if (!key) throw new CloudError('IMAGE_UNAVAILABLE', 'This image provider is not available on Pixel Studio Cloud.', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  try {
    return { images: await requestImages({ ...options, key }, { fetchImpl, signal: controller.signal }) };
  } catch (error) {
    if (signal?.aborted) throw new CloudError('CANCELLED', 'The image request was cancelled.', 499);
    const safe = imageError(error);
    // Key and quota problems are the operator's, not the user's.
    if (safe.status === 401 || safe.status === 429) throw new CloudError('IMAGE_BUSY', 'The image service is unavailable right now. Try again later; no credits were used.', 503);
    throw new CloudError(safe.code, safe.message, safe.status);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); }
}
