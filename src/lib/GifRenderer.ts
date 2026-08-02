import type { FFmpeg, FFMessageLoadConfig, FileData } from '@ffmpeg/ffmpeg';

export type FfmpegClient = Pick<FFmpeg, 'deleteFile' | 'exec' | 'load' | 'readFile' | 'writeFile'>;

export interface GifRenderInput {
  id: number;
  baseGif: FileData;
  overlayImage: FileData;
  filterGraph: string;
  loop?: number;
}

export class GifRenderer {
  readonly #ffmpeg: FfmpegClient;
  readonly #loadConfig: FFMessageLoadConfig;
  #ready: Promise<boolean> | null = null;

  constructor(ffmpeg: FfmpegClient, loadConfig: FFMessageLoadConfig) {
    this.#ffmpeg = ffmpeg;
    this.#loadConfig = loadConfig;
  }

  async prepare() {
    await this.#ensureReady();
  }

  async render({ id, baseGif, overlayImage, filterGraph, loop = 0 }: GifRenderInput) {
    await this.#ensureReady();

    const inputName = `base-${id}.gif`;
    const overlayName = `overlay-${id}`;
    const outputName = `rendered-${id}.gif`;

    try {
      await this.#ffmpeg.writeFile(inputName, baseGif);
      await this.#ffmpeg.writeFile(overlayName, overlayImage);
      await this.#ffmpeg.exec([
        '-i',
        inputName,
        '-i',
        overlayName,
        '-filter_complex',
        filterGraph,
        '-loop',
        String(loop),
        outputName,
      ]);
      return await this.#ffmpeg.readFile(outputName);
    } finally {
      await Promise.allSettled([
        this.#ffmpeg.deleteFile(inputName),
        this.#ffmpeg.deleteFile(overlayName),
        this.#ffmpeg.deleteFile(outputName),
      ]);
    }
  }

  async #ensureReady() {
    const loadPromise = this.#ready ?? this.#ffmpeg.load(this.#loadConfig);
    this.#ready = loadPromise;

    try {
      await loadPromise;
    } catch (error) {
      if (this.#ready === loadPromise) this.#ready = null;
      throw error;
    }
  }
}
