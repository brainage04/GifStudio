export interface DecodedFrame {
  /** PNG bytes for one frame. */
  data: Uint8Array;
  /** How long the frame is held, in milliseconds. */
  durationMs: number;
}

export interface DecodedAnimation {
  frames: DecodedFrame[];
  /** Uniform rate approximating the source's per-frame delays, for sequence inputs. */
  framerate: number;
}

const MAX_FRAMES = 240;
const FALLBACK_DURATION_MS = 100;
const MIN_DURATION_MS = 20;
const MIN_FRAMERATE = 2;
const MAX_FRAMERATE = 50;
const FALLBACK_FRAMERATE = 10;

/**
 * Decode an animation with the browser's own image pipeline.
 *
 * FFmpeg's WebAssembly core cannot open everything the browser can — animated WebP and AVIF are the
 * common ones — and a rejected decode is reported as a non-zero exit code with a zero-byte output,
 * which used to look like a successful render. Callers retry the render with this PNG frame
 * sequence, which also keeps each frame's original delay. A `null` result means the browser cannot
 * decode the file either, so the caller should surface the original FFmpeg failure instead of
 * pretending it recovered.
 */
export const decodeAnimationFrames = async (file: File): Promise<DecodedAnimation | null> => {
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
    const frameCount = Math.min(decoder.tracks.selectedTrack?.frameCount ?? 0, MAX_FRAMES);
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

    // Frame delays vary (GIF and WebP both allow it); a sequence input can only approximate them.
    const sortedDurations = frames.map((frame) => frame.durationMs).sort((left, right) => left - right);
    const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)] ?? 0;
    const framerate =
      medianDuration > 0 ? Math.min(MAX_FRAMERATE, Math.max(MIN_FRAMERATE, 1000 / medianDuration)) : FALLBACK_FRAMERATE;

    return { frames, framerate };
  } catch {
    return null;
  } finally {
    decoder.close();
  }
};
