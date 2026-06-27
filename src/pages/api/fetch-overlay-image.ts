import type { APIRoute } from 'astro';
import { ClientError, binaryAttachmentHeaders, bufferBody, jsonError } from '../../lib/responses';
import { RemoteFetchError, detectImageFormat, fetchRemoteBinary, filenameForUrl } from '../../lib/remoteImages';

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
      accept: 'image/*,*/*;q=0.1',
      label: 'Image',
    });
    const format = detectImageFormat(remote.buffer);

    if (!format) {
      throw new RemoteFetchError(`URL did not return a supported image (content type was ${remote.contentType})`);
    }

    const filename = filenameForUrl(remote.finalUrl, `overlay${format.extension}`, format.extension);
    return new Response(bufferBody(remote.buffer), {
      status: 200,
      headers: binaryAttachmentHeaders(format.contentType, filename, remote.buffer.length),
    });
  } catch (error) {
    if (error instanceof ClientError || error instanceof RemoteFetchError) {
      return jsonError(error.message, 400);
    }

    const message = error instanceof Error ? error.message : 'Overlay image fetch failed.';
    return jsonError(message, 500);
  }
};
