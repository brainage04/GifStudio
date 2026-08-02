import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GifRenderer, type FfmpegClient } from './GifRenderer';

let deletedPaths: string[];
let ffmpeg: FfmpegClient;

beforeEach(() => {
  deletedPaths = [];
  ffmpeg = {
    load: vi.fn(async () => true),
    writeFile: vi.fn(async () => true),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([71, 73, 70])),
    deleteFile: vi.fn(async (path) => {
      deletedPaths.push(path);
      return true;
    }),
  };
});

describe('GifRenderer', () => {
  it('clears a rejected load promise so the renderer can retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValueOnce(true);
    ffmpeg.load = load;
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(renderer.prepare()).rejects.toThrow('load failed');
    await expect(renderer.prepare()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('deletes every temporary path when FFmpeg execution fails', async () => {
    ffmpeg.exec = vi.fn(async () => {
      throw new Error('encode failed');
    });
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 7,
        baseGif: new Uint8Array([1]),
        overlayImage: new Uint8Array([2]),
        filterGraph: 'overlay',
      }),
    ).rejects.toThrow('encode failed');

    expect(deletedPaths).toEqual(['base-7.gif', 'overlay-7', 'rendered-7.gif']);
  });

  it('returns rendered bytes and cleans files after a successful render', async () => {
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 11,
        baseGif: new Uint8Array([1]),
        overlayImage: new Uint8Array([2]),
        filterGraph: 'overlay',
      }),
    ).resolves.toEqual(new Uint8Array([71, 73, 70]));
    expect(deletedPaths).toEqual(['base-11.gif', 'overlay-11', 'rendered-11.gif']);
  });
});
