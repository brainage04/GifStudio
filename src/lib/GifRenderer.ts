import type { FFmpeg, FFMessageLoadConfig, FileData } from '@ffmpeg/ffmpeg';

export type FfmpegClient = Pick<FFmpeg, 'deleteFile' | 'exec' | 'load' | 'readFile' | 'writeFile'>;

export interface GifRenderSource {
  /** Source filename; its extension tells FFmpeg which demuxer to prefer. */
  name: string;
  data: FileData;
}

export interface GifRenderInput {
  id: number;
  base: GifRenderSource;
  overlay: GifRenderSource;
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

  async render({ id, base, overlay, filterGraph, loop = 0 }: GifRenderInput) {
    await this.#ensureReady();

    // FFmpeg picks its demuxer from content first, but a matching extension keeps the choice explicit.
    const baseExtension = (/\.([a-z0-9]+)$/i.exec(base.name)?.[1] ?? 'bin').toLowerCase();
    const overlayExtension = (/\.([a-z0-9]+)$/i.exec(overlay.name)?.[1] ?? 'bin').toLowerCase();
    const baseName = `base-${id}.${baseExtension}`;
    const overlayName = `overlay-${id}.${overlayExtension}`;
    const outputName = `rendered-${id}.gif`;

    try {
      await this.#ffmpeg.writeFile(baseName, base.data);
      await this.#ffmpeg.writeFile(overlayName, overlay.data);
      await this.#ffmpeg.exec([
        '-i',
        baseName,
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
        this.#ffmpeg.deleteFile(baseName),
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
