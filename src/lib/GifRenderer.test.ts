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

  it('shares one in-flight load between concurrent callers', async () => {
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await Promise.all([renderer.prepare(), renderer.prepare()]);

    expect(ffmpeg.load).toHaveBeenCalledTimes(1);
  });

  it('passes source files, filter graph, and loop count to FFmpeg', async () => {
    const baseGif = new Uint8Array([1]);
    const overlayImage = new Uint8Array([2]);
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await renderer.render({
      id: 13,
      base: { name: 'woman_is_talking.gif', data: baseGif },
      overlay: { name: 'Portrait.PNG', data: overlayImage },
      filterGraph: '[0:v][1:v]overlay=4:8',
      loop: 2,
    });

    expect(ffmpeg.writeFile).toHaveBeenNthCalledWith(1, 'base-13.gif', baseGif, expect.anything());
    expect(ffmpeg.writeFile).toHaveBeenNthCalledWith(2, 'overlay-13.png', overlayImage, expect.anything());
    expect(ffmpeg.exec).toHaveBeenCalledWith(
      [
        '-i',
        'base-13.gif',
        '-i',
        'overlay-13.png',
        '-filter_complex',
        '[0:v][1:v]overlay=4:8',
        '-loop',
        '2',
        'rendered-13.gif',
      ],
      undefined,
      expect.anything(),
    );
    expect(ffmpeg.readFile).toHaveBeenCalledWith('rendered-13.gif', undefined, expect.anything());
  });

  it('deletes every temporary path when FFmpeg execution fails', async () => {
    ffmpeg.exec = vi.fn(async () => {
      throw new Error('encode failed');
    });
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 7,
        base: { name: 'base.gif', data: new Uint8Array([1]) },
        overlay: { name: 'overlay.webp', data: new Uint8Array([2]) },
        filterGraph: 'overlay',
      }),
    ).rejects.toThrow('encode failed');

    expect(deletedPaths).toEqual(['base-7.gif', 'overlay-7.webp', 'rendered-7.gif']);
  });

  it('returns rendered bytes and cleans files after a successful render', async () => {
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 11,
        base: { name: 'photo.jpeg', data: new Uint8Array([1]) },
        overlay: { name: 'overlay', data: new Uint8Array([2]) },
        filterGraph: 'overlay',
      }),
    ).resolves.toEqual(new Uint8Array([71, 73, 70]));
    expect(deletedPaths).toEqual(['base-11.jpeg', 'overlay-11.bin', 'rendered-11.gif']);
  });

  it('fails the render when FFmpeg exits non-zero, leaving no result behind', async () => {
    ffmpeg.exec = vi.fn(async () => 1);
    ffmpeg.readFile = vi.fn(async () => new Uint8Array());
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 21,
        base: { name: 'base.webp', data: new Uint8Array([1]) },
        overlay: { name: 'overlay.png', data: new Uint8Array([2]) },
        filterGraph: 'overlay',
      }),
    ).rejects.toThrow('FFmpeg exited with code 1.');
    expect(deletedPaths).toEqual(['base-21.webp', 'overlay-21.png', 'rendered-21.gif']);
  });

  it('fails the render when FFmpeg writes a zero-byte output', async () => {
    ffmpeg.readFile = vi.fn(async () => new Uint8Array());
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 22,
        base: { name: 'base.gif', data: new Uint8Array([1]) },
        overlay: { name: 'overlay.png', data: new Uint8Array([2]) },
        filterGraph: 'overlay',
      }),
    ).rejects.toThrow('FFmpeg wrote an empty GIF.');
    expect(deletedPaths).toEqual(['base-22.gif', 'overlay-22.png', 'rendered-22.gif']);
  });

  it('writes frame-sequence inputs and applies per-input arguments', async () => {
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await renderer.render({
      id: 5,
      base: { name: 'frames-5.txt', data: 'ffconcat version 1.0' },
      overlay: { name: 'overlay.png', data: new Uint8Array([2]) },
      filterGraph: 'overlay',
      inputArgs: { base: ['-f', 'concat', '-safe', '0'] },
      outputArgs: ['-final_delay', '7'],
      extraFiles: [
        { name: 'frame-5-0000.png', data: new Uint8Array([3]) },
        { name: 'frame-5-0001.png', data: new Uint8Array([4]) },
      ],
    });

    expect(ffmpeg.writeFile).toHaveBeenCalledWith('frame-5-0001.png', new Uint8Array([4]), expect.anything());
    expect(ffmpeg.exec).toHaveBeenCalledWith(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'base-5.txt',
        '-i',
        'overlay-5.png',
        '-filter_complex',
        'overlay',
        '-loop',
        '0',
        '-final_delay',
        '7',
        'rendered-5.gif',
      ],
      undefined,
      expect.anything(),
    );
    expect(deletedPaths).toEqual([
      'base-5.txt',
      'overlay-5.png',
      'frame-5-0000.png',
      'frame-5-0001.png',
      'rendered-5.gif',
    ]);
  });

  it('stops before running FFmpeg once the render is aborted, and still cleans up', async () => {
    const controller = new AbortController();
    ffmpeg.writeFile = vi.fn(async () => {
      controller.abort();
      return true;
    });
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(
      renderer.render({
        id: 31,
        base: { name: 'base.gif', data: new Uint8Array([1]) },
        overlay: { name: 'overlay.png', data: new Uint8Array([2]) },
        filterGraph: 'overlay',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ffmpeg.writeFile).toHaveBeenCalledTimes(1);
    expect(ffmpeg.exec).not.toHaveBeenCalled();
    expect(deletedPaths).toEqual(['base-31.gif', 'overlay-31.png', 'rendered-31.gif']);
  });

  it('reports whether FFmpeg decodes a source on its own and removes the probe file', async () => {
    const renderer = new GifRenderer(ffmpeg, { coreURL: '/core.js', wasmURL: '/core.wasm' });

    await expect(renderer.decodes(3, { name: 'base.gif', data: new Uint8Array([1]) })).resolves.toBe(true);
    ffmpeg.exec = vi.fn(async () => 1);
    await expect(renderer.decodes(4, { name: 'base.webp', data: new Uint8Array([1]) })).resolves.toBe(false);
    expect(deletedPaths).toEqual(['probe-3.gif', 'probe-4.webp']);
  });
});
