/** Consume only a completed response. A partial stream never becomes an edit. */
export async function readLocalEditResponse(response, onEvent = () => {}, signal) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `The local service could not start this edit (${response.status}).`);
  }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body) {
    throw new Error('This address is not running the Pixel Studio local AI service. Start the local edition with npm start.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let textLength = 0;
  let finalText;
  const parse = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('The local service returned an invalid response. Try the edit again.'); }
    if (event.type === 'error') throw new Error(event.error || 'Codex could not complete this edit.');
    if (event.type === 'delta') {
      if (typeof event.text !== 'string') throw new Error('Codex returned an invalid text update.');
      textLength += event.text.length;
      if (textLength > 4 * 1024 * 1024) throw new Error('This edit is too large. Try one animation or frame at a time.');
      onEvent({ type: 'delta', characters: textLength });
    } else if (event.type === 'status') {
      onEvent({ type: 'status', message: String(event.message || '').slice(0, 500) });
    } else if (event.type === 'done') {
      if (typeof event.text !== 'string' || !event.text.trim()) throw new Error('Codex completed without returning pixel data. Try again.');
      if (new TextEncoder().encode(event.text).length > 4 * 1024 * 1024) throw new Error('This edit is too large. Try one animation or frame at a time.');
      finalText = event.text;
      // Pixel Studio Cloud reports the credits this request used and what is left.
      if (event.credits && typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') globalThis.dispatchEvent(new CustomEvent('pixel-studio:credits', { detail: event.credits }));
    }
  };
  try {
    while (finalText === undefined) {
      if (signal?.aborted) throw new DOMException('Edit cancelled.', 'AbortError');
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) parse(buffer);
        break;
      }
      received += value.byteLength;
      if (received > 12 * 1024 * 1024) throw new Error('The local response exceeded the edit limit. Try a smaller selection.');
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1 && finalText === undefined) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parse(line);
      }
    }
    if (signal?.aborted) throw new DOMException('Edit cancelled.', 'AbortError');
    if (finalText === undefined) throw new Error('The connection ended before Codex finished. No edit is ready to apply; try again.');
    return finalText;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

