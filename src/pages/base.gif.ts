import { readFile } from 'node:fs/promises';
import type { APIRoute } from 'astro';
import { baseGifAsset, findStaticAsset } from '../lib/assetPaths';
import { noStoreHeaders } from '../lib/responses';

export const prerender = false;

export const GET: APIRoute = async () => {
  const filePath = await findStaticAsset(...baseGifAsset);
  const gif = await readFile(filePath);
  return new Response(gif, {
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'image/gif',
      'Content-Length': String(gif.length),
    },
  });
};
