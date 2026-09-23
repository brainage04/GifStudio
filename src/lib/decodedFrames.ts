export interface DecodedFrame {
  /** PNG bytes for one frame. */
  data: Uint8Array;
  /** How long the frame is held, in milliseconds. */
  durationMs: number;
}

export interface DecodedAnimation {
  frames: DecodedFrame[];
  /** Frames in the source; more than `frames.length` when the animation was truncated to `MAX_DECODED_FRAMES`. */
  totalFrames: number;
}

/**
 * Every decoded frame is held as PNG bytes here and again in FFmpeg's WebAssembly heap next to the
 * rendered GIF, and that heap cannot grow past a few GB. A fixed cap keeps the fallback predictable
 * where a byte budget would depend on how well each frame compresses; callers tell the reader when
 * it truncates (`totalFrames > frames.length`).
 */
export const MAX_DECODED_FRAMES = 240;
const FALLBACK_DURATION_MS = 100;
const MIN_DURATION_MS = 20;

/**
 * FFmpeg input for a decoded frame sequence that keeps every frame's own delay.
 *
 * The concat demuxer places each PNG at the running total of the `duration`s before it. Image inputs
 * default to a 1/25 s time base, which would round delays to 40 ms steps, so each file is opened at
 * 100 fps — the centisecond resolution GIF delays are stored in. The demuxer cannot express how long
 * the last frame stays up, so it becomes the GIF muxer's `-final_delay` (in centiseconds).
 */
export const frameSequenceInput = (frames: readonly { name: string; durationMs: number }[]) => {
  const centiseconds = frames.map(({ durationMs }) => Math.max(Math.round(durationMs / 10), 1));
  const lines = ['ffconcat version 1.0'];
  frames.forEach(({ name }, index) => {
    lines.push(`file '${name}'`, 'option framerate 100', `duration ${((centiseconds[index] ?? 1) / 100).toFixed(2)}`);
  });

  return {
    script: `${lines.join('\n')}\n`,
    inputArgs: ['-f', 'concat', '-safe', '0'],
    outputArgs: ['-final_delay', String(centiseconds.at(-1) ?? 1)],
  };
};

/**
 * Decode an animation with the browser's own image pipeline.
 *
 * FFmpeg's WebAssembly core cannot open everything the browser can — animated WebP and AVIF are the
 * common ones — and a rejected decode is reported as a non-zero exit code with a zero-byte output,
 * which used to look like a successful render. Callers retry the render with this PNG frame
 * sequence, which also keeps each frame's original delay. A `null` result means the browser cannot
 * decode the file either, so the caller should surface the original FFmpeg failure instead of
 * pretending it recovered. Aborting `signal` rejects with its reason.
 */
export const decodeAnimationFrames = async (file: File, signal?: AbortSignal): Promise<DecodedAnimation | null> => {
  if (typeof ImageDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return null;
  }
  if (!(await ImageDecoder.isTypeSupported(file.type))) {
    return null;
  }

  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
  try {
    await decoder.completed;
    await decoder.tracks.ready;
    const totalFrames = decoder.tracks.selectedTrack?.frameCount ?? 0;
    const frameCount = Math.min(totalFrames, MAX_DECODED_FRAMES);
    if (!frameCount) {
      return null;
    }

    const first = await decoder.decode({ frameIndex: 0 });
    const width = first.image.displayWidth || first.image.codedWidth;
    const height = first.image.displayHeight || first.image.codedHeight;
    if (!width || !height) {
      first.image.close();
      return null;
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      first.image.close();
      return null;
    }

    const frames: DecodedFrame[] = [];
    let frame = first;
    for (let index = 0; index < frameCount; index += 1) {
      if (index > 0) {
        signal?.throwIfAborted();
        frame = await decoder.decode({ frameIndex: index });
      }
      context.clearRect(0, 0, width, height);
      context.drawImage(frame.image, 0, 0, width, height);
      const durationMs = (frame.image.duration ?? 0) / 1000;
      frame.image.close();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      frames.push({
        data: new Uint8Array(await blob.arrayBuffer()),
        durationMs: Math.max(durationMs || FALLBACK_DURATION_MS, MIN_DURATION_MS),
      });
    }

    return { frames, totalFrames };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return null;
  } finally {
    decoder.close();
  }
};
