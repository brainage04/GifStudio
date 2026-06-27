import type { APIRoute } from 'astro';
import { ClientError, binaryAttachmentHeaders, bufferBody, jsonError } from '../../lib/responses';
import { RemoteFetchError, fetchRemoteBinary, filenameForUrl, isGifBytes } from '../../lib/remoteImages';

export const prerender = false;

const readUrlPayload = async (request: Request) => {
  const text = await request.text();
  if (!text.trim()) {
    throw new ClientError('Empty request body');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ClientError('Invalid JSON body');
  }

  if (!payload || typeof payload !== 'object' || !('url' in payload) || typeof payload.url !== 'string') {
    throw new ClientError('URL is required');
  }

  const url = payload.url.trim();
  if (!url) {
    throw new ClientError('URL is required');
  }

  return url;
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const url = await readUrlPayload(request);
    const remote = await fetchRemoteBinary(url, {
      accept: 'image/gif,image/*;q=0.8,*/*;q=0.1',
      label: 'GIF',
    });

    if (!isGifBytes(remote.buffer)) {
      throw new RemoteFetchError(`URL did not return a valid GIF (content type was ${remote.contentType})`);
    }

    const filename = filenameForUrl(remote.finalUrl, 'base.gif', '.gif');
    return new Response(bufferBody(remote.buffer), {
      status: 200,
      headers: binaryAttachmentHeaders('image/gif', filename, remote.buffer.length),
    });
  } catch (error) {
    if (error instanceof ClientError || error instanceof RemoteFetchError) {
      return jsonError(error.message, 400);
    }

    const message = error instanceof Error ? error.message : 'Base GIF fetch failed.';
    return jsonError(message, 500);
  }
};
