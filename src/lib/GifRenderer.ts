import type { FFmpeg, FFMessageLoadConfig, FileData } from '@ffmpeg/ffmpeg';

export type FfmpegClient = Pick<FFmpeg, 'deleteFile' | 'exec' | 'load' | 'readFile' | 'writeFile'>;

export interface GifRenderSource {
  /** Filename FFmpeg opens; its extension tells FFmpeg which demuxer to prefer. */
  name: string;
  data: FileData;
  /** MEMFS path for `data`, when FFmpeg must open something other than the written file (e.g. an image2 pattern). */
  writePath?: string;
}

export interface GifRenderInput {
  id: number;
  base: GifRenderSource;
  overlay: GifRenderSource;
  filterGraph: string;
  loop?: number;
  /** Extra MEMFS files the inputs reference, written before exec and deleted after (e.g. a PNG frame sequence). */
  extraFiles?: GifRenderSource[];
  /** Options inserted before each `-i` for inputs that need them (e.g. `-framerate` on a frame sequence). */
  inputArgs?: { base?: readonly string[]; overlay?: readonly string[] };
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

  async render({ id, base, overlay, filterGraph, loop = 0, extraFiles = [], inputArgs = {} }: GifRenderInput) {
    await this.#ensureReady();

    // FFmpeg picks its demuxer from content first, but a matching extension keeps the choice explicit.
    const baseExtension = (/\.([a-z0-9]+)$/i.exec(base.name)?.[1] ?? 'bin').toLowerCase();
    const overlayExtension = (/\.([a-z0-9]+)$/i.exec(overlay.name)?.[1] ?? 'bin').toLowerCase();
    const basePath = base.writePath ?? `base-${id}.${baseExtension}`;
    const overlayPath = overlay.writePath ?? `overlay-${id}.${overlayExtension}`;
    // Without an explicit path FFmpeg reads what we wrote; with one it reads `name` (an image2 pattern, say).
    const baseName = base.writePath ? base.name : basePath;
    const overlayName = overlay.writePath ? overlay.name : overlayPath;
    const outputName = `rendered-${id}.gif`;

    try {
      await this.#ffmpeg.writeFile(basePath, base.data);
      await this.#ffmpeg.writeFile(overlayPath, overlay.data);
      for (const file of extraFiles) {
        await this.#ffmpeg.writeFile(file.name, file.data);
      }

      // A rejected input leaves a zero-byte output behind instead of rejecting, so both signals matter.
      const exitCode = await this.#ffmpeg.exec([
        ...(inputArgs.base ?? []),
        '-i',
        baseName,
        ...(inputArgs.overlay ?? []),
        '-i',
        overlayName,
        '-filter_complex',
        filterGraph,
        '-loop',
        String(loop),
        outputName,
      ]);
      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}.`);
      }

      const output = await this.#ffmpeg.readFile(outputName);
      if (!output.length) {
        throw new Error('FFmpeg wrote an empty GIF.');
      }
      return output;
    } finally {
      await Promise.allSettled(
        [basePath, overlayPath, ...extraFiles.map((file) => file.name), outputName].map((path) =>
          this.#ffmpeg.deleteFile(path),
        ),
      );
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
