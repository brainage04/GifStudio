import { readFile } from 'node:fs/promises';
import type { APIRoute } from 'astro';
import { defaultOverlayAsset, findStaticAsset } from '../lib/assetPaths';
import { noStoreHeaders } from '../lib/responses';

export const prerender = false;

export const GET: APIRoute = async () => {
  const filePath = await findStaticAsset(...defaultOverlayAsset);
  const image = await readFile(filePath);
  return new Response(image, {
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'image/jpeg',
      'Content-Length': String(image.length),
    },
  });
};
