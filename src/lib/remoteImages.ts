import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

export class RemoteFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFetchError';
  }
}

type RemoteBinaryOptions = {
  accept: string;
  label: 'GIF' | 'Image';
  maxBytes?: number;
  timeoutMs?: number;
  redirects?: number;
};

export type RemoteBinary = {
  buffer: Buffer;
  contentType: string;
  finalUrl: URL;
};

export type ImageFormat = {
  extension: '.png' | '.jpg' | '.gif' | '.webp';
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

const privateIPv4Ranges: Array<[number, number]> = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0000200, 0xc00002ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
];

const ipv4ToNumber = (address: string) =>
  address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;

const isBlockedIp = (address: string) => {
  const version = net.isIP(address);
  if (version === 4) {
    const numeric = ipv4ToNumber(address);
    return privateIPv4Ranges.some(([start, end]) => numeric >= start && numeric <= end);
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('ff')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
      || normalized.startsWith('::ffff:169.254.');
  }

  return true;
};

const parseHttpUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RemoteFetchError('URL is invalid');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RemoteFetchError('Only http and https image URLs are supported');
  }

  if (!url.hostname || ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) {
    throw new RemoteFetchError('Local image URLs are not supported');
  }

  return url;
};

const assertPublicDestination = async (url: URL) => {
  const hostname = url.hostname;
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new RemoteFetchError('Private network image URLs are not supported');
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new RemoteFetchError('Image host could not be resolved');
  }

  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new RemoteFetchError('Private network image URLs are not supported');
  }
};

const readResponseBuffer = async (response: Response, maxBytes: number) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new RemoteFetchError('Remote image is too large');
  }

  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new RemoteFetchError('Remote image is too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, total);
};

export const fetchRemoteBinary = async (value: string, options: RemoteBinaryOptions): Promise<RemoteBinary> => {
  const {
    accept,
    label,
    maxBytes = 16 * 1024 * 1024,
    timeoutMs = 20000,
    redirects = 5,
  } = options;
  const url = parseHttpUrl(value);
  await assertPublicDestination(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'GifStudio/1.0',
        Accept: accept,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    throw new RemoteFetchError(`${label} fetch failed: ${error instanceof Error ? error.message : 'request failed'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
    if (redirects <= 0) {
      throw new RemoteFetchError(`${label} fetch failed: too many redirects`);
    }
    const nextUrl = new URL(response.headers.get('location') ?? '', url);
    return fetchRemoteBinary(nextUrl.href, { ...options, redirects: redirects - 1 });
  }

  if (!response.ok) {
    throw new RemoteFetchError(`${label} fetch failed: ${response.statusText || response.status}`);
  }

  const buffer = await readResponseBuffer(response, maxBytes);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { buffer, contentType, finalUrl: url };
};

export const isGifBytes = (buffer: Buffer | Uint8Array) => {
  const header = Buffer.from(buffer.subarray(0, 6)).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
};

export const detectImageFormat = (buffer: Buffer | Uint8Array): ImageFormat | null => {
  if (buffer.length >= 8 && Buffer.from(buffer.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', contentType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', contentType: 'image/jpeg' };
  }
  if (isGifBytes(buffer)) {
    return { extension: '.gif', contentType: 'image/gif' };
  }
  if (buffer.length >= 12 && Buffer.from(buffer.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(buffer.subarray(8, 12)).toString('ascii') === 'WEBP') {
    return { extension: '.webp', contentType: 'image/webp' };
  }
  return null;
};

const basenameFromUrl = (url: URL, fallback: string) => {
  const rawName = path.posix.basename(url.pathname);
  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    decodedName = rawName;
  }

  const sanitized = decodedName.replace(/[\\/\0\r\n"]/g, '_');
  return sanitized && sanitized !== '.' ? sanitized : fallback;
};

export const filenameForUrl = (url: URL, fallback: string, extension?: string) => {
  const filename = basenameFromUrl(url, fallback);
  if (!extension || filename.toLowerCase().endsWith(extension)) {
    return filename;
  }
  return `${filename}${extension}`;
};
