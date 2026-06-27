import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

export type OverlaySettings = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleDivisor?: number;
  loop?: number;
};

export class OverlayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayValidationError';
  }
}

export type RenderOverlayGifOptions = {
  inputGif: string;
  overlayImage: string;
  outputGif: string;
  settings?: OverlaySettings;
  timeoutMs?: number;
};

const assertReadableFile = async (filePath: string, label: string) => {
  try {
    await access(filePath);
  } catch (error) {
    throw new Error(`${label} not found: ${filePath}`, { cause: error });
  }
};

const scaleExpression = (size: number | undefined, scaleDivisor: number) =>
  typeof size === 'number' ? String(size) : `trunc(iw/${scaleDivisor})`;

const boundedOutput = (chunks: Buffer[], chunk: Buffer, maxBytes = 65536) => {
  chunks.push(chunk);
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > maxBytes && chunks.length > 1) {
    total -= chunks.shift()?.length ?? 0;
  }
};

const runFfmpeg = (args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = windowlessSetTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => boundedOutput(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => boundedOutput(stderr, chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`ffmpeg failed: ${error.message}`, { cause: error }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      const output = Buffer.concat(stderr).toString('utf8').trim()
        || Buffer.concat(stdout).toString('utf8').trim()
        || (timedOut ? `timed out after ${timeoutMs}ms` : `exited with ${signal ?? code}`);
      reject(new Error(`ffmpeg failed: ${output}`));
    });
  });

const windowlessSetTimeout = (handler: () => void, timeoutMs: number) =>
  setTimeout(handler, timeoutMs);

export const renderOverlayGif = async ({
  inputGif,
  overlayImage,
  outputGif,
  settings = {},
  timeoutMs = 30000,
}: RenderOverlayGifOptions): Promise<string> => {
  const {
    x = 58,
    y = 0,
    width,
    height,
    scaleDivisor = 2.0,
    loop = 0,
  } = settings;

  if (!Number.isFinite(scaleDivisor) || scaleDivisor <= 0) {
    throw new OverlayValidationError('scaleDivisor must be greater than 0');
  }

  if (typeof width === 'number' && (!Number.isFinite(width) || width <= 0)) {
    throw new OverlayValidationError('width must be greater than 0');
  }

  if (typeof height === 'number' && (!Number.isFinite(height) || height <= 0)) {
    throw new OverlayValidationError('height must be greater than 0');
  }

  await assertReadableFile(inputGif, 'Input GIF');
  await assertReadableFile(overlayImage, 'Overlay image');

  const scaleWidth = scaleExpression(width, scaleDivisor);
  const scaleHeight = typeof height === 'number' ? String(height) : `trunc(ih/${scaleDivisor})`;
  const filterGraph = [
    `[1:v]scale=${scaleWidth}:${scaleHeight}[overlay]`,
    `[0:v][overlay]overlay=${x}:${y},split[gif][palette_src]`,
    '[palette_src]palettegen[palette]',
    '[gif][palette]paletteuse',
  ].join(';');

  await runFfmpeg([
    '-y',
    '-i', inputGif,
    '-i', overlayImage,
    '-filter_complex', filterGraph,
    '-loop', String(loop),
    outputGif,
  ], timeoutMs);

  return outputGif;
};
