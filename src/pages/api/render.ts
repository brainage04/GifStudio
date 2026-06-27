import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { baseGifAsset, findStaticAsset } from '../../lib/assetPaths';
import { ClientError, binaryAttachmentHeaders, jsonError } from '../../lib/responses';
import { OverlayValidationError, renderOverlayGif, type OverlaySettings } from '../../lib/renderOverlayGif';

export const prerender = false;

const roundHalfToEven = (value: number) => {
  const sign = Math.sign(value) || 1;
  const absolute = Math.abs(value);
  const floor = Math.floor(absolute);
  const difference = absolute - floor;

  if (Math.abs(difference - 0.5) < Number.EPSILON) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    return sign * even;
  }

  return Math.round(value);
};

const formText = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : undefined;
};

const coerceRoundedInt = (value: string | undefined, defaultValue: number) => {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ClientError(`${value} is not a valid number`);
  }

  return roundHalfToEven(numeric);
};

const coerceOptionalRoundedInt = (value: string | undefined) => {
  if (value === undefined || value === '') {
    return undefined;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ClientError(`${value} is not a valid number`);
  }

  return roundHalfToEven(numeric);
};

const coerceFloat = (value: string | undefined, defaultValue: number) => {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ClientError(`${value} is not a valid number`);
  }

  return numeric;
};

const uploadExtension = (filename: string, fallback: string) => {
  const extension = path.extname(filename).toLowerCase();
  return extension && extension.length <= 12 ? extension : fallback;
};

const writeUpload = async (file: File, filePath: string) => {
  const bytes = await file.arrayBuffer();
  await writeFile(filePath, Buffer.from(bytes));
};

const readRequiredUpload = (formData: FormData, fieldName: string) => {
  const value = formData.get(fieldName);
  if (!(value instanceof File)) {
    throw new ClientError('Missing overlay file');
  }
  if (value.size === 0) {
    throw new ClientError('Uploaded overlay file is empty');
  }
  return value;
};

const readOptionalUpload = (formData: FormData, fieldName: string) => {
  const value = formData.get(fieldName);
  if (value instanceof File && value.size > 0) {
    return value;
  }
  return undefined;
};

const readSettings = (formData: FormData): OverlaySettings => ({
  x: coerceRoundedInt(formText(formData, 'x'), 58),
  y: coerceRoundedInt(formText(formData, 'y'), 0),
  width: coerceOptionalRoundedInt(formText(formData, 'width')),
  height: coerceOptionalRoundedInt(formText(formData, 'height')),
  scaleDivisor: coerceFloat(formText(formData, 'scaleDivisor'), 2.0),
  loop: 0,
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      throw new ClientError('Expected multipart form data');
    }

    const formData = await request.formData();
    const overlay = readRequiredUpload(formData, 'overlay');
    const baseGif = readOptionalUpload(formData, 'baseGif');
    const settings = readSettings(formData);
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gifstudio-'));

    try {
      const overlayPath = path.join(tmpDir, `overlay${uploadExtension(overlay.name, '.webp')}`);
      const outputPath = path.join(tmpDir, 'rendered.gif');
      await writeUpload(overlay, overlayPath);

      let inputGifPath = await findStaticAsset(...baseGifAsset);
      if (baseGif) {
        inputGifPath = path.join(tmpDir, `base${uploadExtension(baseGif.name, '.gif')}`);
        await writeUpload(baseGif, inputGifPath);
      }

      await renderOverlayGif({
        inputGif: inputGifPath,
        overlayImage: overlayPath,
        outputGif: outputPath,
        settings,
      });

      const gif = await readFile(outputPath);
      return new Response(gif, {
        status: 200,
        headers: binaryAttachmentHeaders('image/gif', 'woman_is_talking_overlay.gif', gif.length),
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof ClientError || error instanceof OverlayValidationError) {
      return jsonError(error.message, 400);
    }

    const message = error instanceof Error ? error.message : 'Render failed.';
    return jsonError(message, 500);
  }
};
