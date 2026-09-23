import type { FFmpeg, FFMessageLoadConfig, FileData } from '@ffmpeg/ffmpeg';

export type FfmpegClient = Pick<FFmpeg, 'deleteFile' | 'exec' | 'load' | 'readFile' | 'writeFile'>;

export interface GifRenderSource {
  /** Filename FFmpeg opens; its extension tells FFmpeg which demuxer to prefer. */
  name: string;
  data: FileData;
}

export interface GifRenderInput {
  id: number;
  base: GifRenderSource;
  overlay: GifRenderSource;
  filterGraph: string;
  loop?: number;
  /** Extra MEMFS files the inputs reference, written before exec and deleted after (e.g. a PNG frame sequence). */
  extraFiles?: GifRenderSource[];
  /** Options inserted before each `-i` for inputs that need them (e.g. `-f concat` on a frame sequence). */
  inputArgs?: { base?: readonly string[]; overlay?: readonly string[] };
  /** Options inserted before the output file (e.g. `-final_delay`). */
  outputArgs?: readonly string[];
  /** Rejects the render with an `AbortError`; FFmpeg finishes a running command, but its result is dropped. */
  signal?: AbortSignal;
}

const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'bin').toLowerCase();

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

  async render({
    id,
    base,
    overlay,
    filterGraph,
    loop = 0,
    extraFiles = [],
    inputArgs = {},
    outputArgs = [],
    signal,
  }: GifRenderInput) {
    await this.#ensureReady();

    // FFmpeg picks its demuxer from content first, but a matching extension keeps the choice explicit.
    const basePath = `base-${id}.${extensionOf(base.name)}`;
    const overlayPath = `overlay-${id}.${extensionOf(overlay.name)}`;
    const outputName = `rendered-${id}.gif`;
    const inputFiles = [{ name: basePath, data: base.data }, { name: overlayPath, data: overlay.data }, ...extraFiles];

    try {
      // FFmpeg only listens for an abort that happens while a call is pending, so check between calls too.
      for (const file of inputFiles) {
        signal?.throwIfAborted();
        await this.#ffmpeg.writeFile(file.name, file.data, { signal });
      }

      signal?.throwIfAborted();
      // A rejected input leaves a zero-byte output behind instead of rejecting, so both signals matter.
      const exitCode = await this.#ffmpeg.exec(
        [
          ...(inputArgs.base ?? []),
          '-i',
          basePath,
          ...(inputArgs.overlay ?? []),
          '-i',
          overlayPath,
          '-filter_complex',
          filterGraph,
          '-loop',
          String(loop),
          ...outputArgs,
          outputName,
        ],
        undefined,
        { signal },
      );
      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}.`);
      }

      signal?.throwIfAborted();
      const output = await this.#ffmpeg.readFile(outputName, undefined, { signal });
      if (!output.length) {
        throw new Error('FFmpeg wrote an empty GIF.');
      }
      return output;
    } finally {
      // Not aborted: the worker runs these after any command still in flight, so nothing is left behind.
      await Promise.allSettled(
        [...inputFiles.map((file) => file.name), outputName].map((path) => this.#ffmpeg.deleteFile(path)),
      );
    }
  }

  /** Whether FFmpeg decodes every frame of `source` on its own; `-xerror` makes any decode error fatal. */
  async decodes(id: number, source: GifRenderSource, signal?: AbortSignal) {
    await this.#ensureReady();

    const path = `probe-${id}.${extensionOf(source.name)}`;
    try {
      signal?.throwIfAborted();
      await this.#ffmpeg.writeFile(path, source.data, { signal });
      signal?.throwIfAborted();
      return (await this.#ffmpeg.exec(['-xerror', '-i', path, '-f', 'null', '-'], undefined, { signal })) === 0;
    } finally {
      await this.#ffmpeg.deleteFile(path).catch(() => false);
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
