export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

export const noStoreHeaders = {
  'Cache-Control': 'no-store',
};

export const bufferBody = (buffer: Buffer): ArrayBuffer => {
  const body = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(body).set(buffer);
  return body;
};

export const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

const sanitizeAttachmentFilename = (filename: string) =>
  filename.replace(/[\\"\r\n]/g, '_') || 'download';

export const binaryAttachmentHeaders = (contentType: string, filename: string, length?: number) => {
  const headers = new Headers({
    ...noStoreHeaders,
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${sanitizeAttachmentFilename(filename)}"`,
  });

  if (typeof length === 'number') {
    headers.set('Content-Length', String(length));
  }

  return headers;
};
