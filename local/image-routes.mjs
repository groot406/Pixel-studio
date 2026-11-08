// HTTP handlers for /api/image/status and /api/image/generate, mounted by local/server.mjs after its
// host/origin checks. Generation needs the CSRF token, runs one request at a time and is cancelled
// when the browser disconnects or the server closes.
import { LocalAIError } from './codex-client.mjs';
import { imageError, readImageRequest } from './image-client.mjs';

function sendJson(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function createImageRoutes({ clientFactory, checkToken, csrfToken, controllers, isClosing }) {
  let active = false;
  return {
    async status(request, response) {
      if (request.method !== 'GET') throw new LocalAIError('METHOD_NOT_ALLOWED', 'Use GET for image status.', 405);
      let providers = {};
      try { providers = await clientFactory().status(); } catch { providers = {}; }
      sendJson(response, 200, { local: true, providers, csrfToken, busy: active });
    },
    async generate(request, response) {
      if (request.method !== 'POST') throw new LocalAIError('METHOD_NOT_ALLOWED', 'Use POST to generate images.', 405);
      if (!checkToken(request.headers['x-pixel-studio-token'])) throw new LocalAIError('INVALID_TOKEN', 'The local connection has changed. Refresh and try again.', 403);
      if (active) throw new LocalAIError('BUSY', 'Another image is being generated. Wait for it to finish.', 409);
      active = true;
      const controller = new AbortController();
      controllers.add(controller);
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      request.once('aborted', cancel);
      response.once('close', cancel);
      try {
        const body = await readImageRequest(request);
        if (controller.signal.aborted || isClosing()) return;
        const { images } = await clientFactory().generate({ ...body, signal: controller.signal });
        if (!controller.signal.aborted) sendJson(response, 200, { images, provider: body.provider, model: body.model });
      } catch (error) {
        if (controller.signal.aborted) return;
        const safe = imageError(error);
        sendJson(response, safe.status === 499 ? 400 : safe.status, { error: safe.message, code: safe.code });
      } finally {
        controllers.delete(controller);
        request.removeListener('aborted', cancel);
        response.removeListener('close', cancel);
        active = false;
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    },
  };
}
