import { gaussianBlur, resizeArea, roundHalfEven } from './pixelOps';

/**
 * Remakes who_is_this_kid.gif with a picture over the kid's face and "KID" swapped for another word.
 *
 * tools/who-is-this/build_template.py did everything that does not depend on the picture: it tracked
 * the face, painted "KID" out (`patch`), fitted the end-of-clip colour regrade, and drew, for each
 * word, everything that sits over the face (`overlays`: the original caption and arrow pixels, the
 * new word and the copied '*'). Per frame this module draws, in order: source frame, patch, picture,
 * overlay. The picture steps follow the original script, rounding included.
 */

/** A crop stored in a sheet image at `(0, sheetY)` that belongs at `(x, y)` in the frame. */
export interface SheetCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  sheetY: number;
}

export interface TemplateFrame {
  /** Smoothed face box: centre x, centre y, width. */
  face?: [number, number, number];
  /** Per RGB channel `[gain, offset]` applied to the picture to follow the clip's white flash and regrade. */
  regrade?: [number, number][];
  patch?: SheetCrop;
  overlays?: Record<string, SheetCrop>;
}

export interface WhoIsThisTemplate {
  width: number;
  height: number;
  fps: number;
  words: string[];
  source: string;
  patches: { file: string; size: [number, number] };
  overlays: { file: string; size: [number, number] };
  frames: TemplateFrame[];
}

/** The template's images decoded: every source frame as RGB, `patches` as RGB, `overlays` as RGBA. */
export interface TemplatePixels {
  frames: Uint8Array;
  patches: Uint8Array;
  overlays: Uint8Array;
}

export const pictureShapes = ['auto', 'circle', 'square', 'alpha'] as const;
export type PictureShape = (typeof pictureShapes)[number];

/** The square picture ready to paste: RGB bytes and a 0-1 paste mask, both `size` x `size`. */
export interface Picture {
  size: number;
  rgb: Uint8Array;
  mask: Float32Array;
}

export interface PictureOptions {
  /** Fraction of the picture's shorter side kept, centred (0.7 = tighter on the face). */
  zoom: number;
  /** auto: the picture's own transparency if it has any, else a feathered circle. */
  shape: PictureShape;
  /** Pictures wider than this are shrunk to it first; see `pictureSizeLimit`. */
  maxSize: number;
}

/**
 * The largest picture worth keeping for a paste `scale`: four times the biggest pasted size. Shrinking
 * a phone photo to it first keeps each frame's resize and the edge feathering fast without visibly
 * changing the result.
 */
export const pictureSizeLimit = (template: WhoIsThisTemplate, scale: number) =>
  4 * Math.max(...template.frames.map((frame) => (frame.face ? Math.trunc(frame.face[2] * scale) : 0)));

/** The original script's `load_pfp`, from RGBA pixels (EXIF rotation already applied by the browser). */
export const preparePicture = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  { zoom, shape, maxSize }: PictureOptions,
): Picture => {
  const keep = Math.max(8, Math.trunc(Math.min(width, height) * zoom));
  const left = Math.floor((width - keep) / 2);
  const top = Math.floor((height - keep) / 2);

  // Centre square crop; like Pillow's crop, anything past the image edge is transparent black.
  let rgb = new Uint8Array(keep * keep * 3);
  let alpha = new Float32Array(keep * keep);
  let translucent = 0;
  for (let y = 0; y < keep; y += 1) {
    for (let x = 0; x < keep; x += 1) {
      const sx = left + x;
      const sy = top + y;
      const i = y * keep + x;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const s = (sy * width + sx) * 4;
        rgb[i * 3] = rgba[s] ?? 0;
        rgb[i * 3 + 1] = rgba[s + 1] ?? 0;
        rgb[i * 3 + 2] = rgba[s + 2] ?? 0;
        alpha[i] = (rgba[s + 3] ?? 0) / 255;
      }
      if ((alpha[i] ?? 0) < 0.99) {
        translucent += 1;
      }
    }
  }
  const resolvedShape = shape === 'auto' ? (translucent / (keep * keep) > 0.02 ? 'alpha' : 'circle') : shape;

  let size = keep;
  if (keep > maxSize) {
    size = maxSize;
    rgb = resizeArea(rgb, keep, keep, 3, size, size);
    alpha = resizeArea(alpha, keep, keep, 1, size, size);
  }
  if (resolvedShape === 'alpha') {
    return { size, rgb, mask: alpha };
  }

  // A shrunk picture gets the circle and feather the full-size crop would have had, scaled down.
  const factor = size / keep;
  const shapeMask = new Float32Array(size * size);
  if (resolvedShape === 'square') {
    shapeMask.fill(1);
  } else {
    const center = Math.floor(keep / 2) * factor;
    const radius = (Math.floor(keep / 2) - Math.max(2, Math.floor(keep / 60))) * factor;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // cv2.circle's filled disc is exactly the pixels within the radius.
        if ((x - center) ** 2 + (y - center) ** 2 <= radius ** 2) {
          shapeMask[y * size + x] = 1;
        }
      }
    }
  }
  const mask = gaussianBlur(shapeMask, size, size, Math.max(1, keep / 90) * factor);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = (mask[i] ?? 0) * (alpha[i] ?? 0);
  }
  return { size, rgb, mask };
};

/** Copy a sheet crop's pixels into the frame, alpha-blending when the sheet has an alpha channel. */
const drawCrop = (
  frame: Uint8Array,
  frameWidth: number,
  sheet: Uint8Array,
  sheetWidth: number,
  channels: 3 | 4,
  crop: SheetCrop,
) => {
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const s = ((crop.sheetY + y) * sheetWidth + x) * channels;
      const d = ((crop.y + y) * frameWidth + crop.x + x) * 3;
      const a = channels === 4 ? (sheet[s + 3] ?? 0) / 255 : 1;
      if (a === 0) {
        continue;
      }
      for (let c = 0; c < 3; c += 1) {
        // np.clip(img * (1 - a) + color * a, 0, 255).astype(np.uint8); the typed array truncates.
        frame[d + c] = Math.min(255, Math.max(0, (frame[d + c] ?? 0) * (1 - a) + (sheet[s + c] ?? 0) * a));
      }
    }
  }
};

/** The original script's `paste_face`, with the regrade taken from the template. */
const pastePicture = (
  frame: Uint8Array,
  width: number,
  height: number,
  picture: Picture,
  face: [number, number, number],
  regrade: [number, number][] | undefined,
  scale: number,
) => {
  const [cx, cy, s] = face;
  const size = Math.max(4, Math.trunc(s * scale));
  const x0 = roundHalfEven(cx - size / 2);
  const y0 = roundHalfEven(cy - size / 2 - s * 0.08);
  const sprite = resizeArea(picture.rgb, picture.size, picture.size, 3, size, size);
  const mask = resizeArea(picture.mask, picture.size, picture.size, 1, size, size);

  for (let y = Math.max(y0, 0); y < Math.min(y0 + size, height); y += 1) {
    for (let x = Math.max(x0, 0); x < Math.min(x0 + size, width); x += 1) {
      const i = (y - y0) * size + (x - x0);
      const m = mask[i] ?? 0;
      const d = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const [gain, offset] = regrade?.[c] ?? [1, 0];
        const value = (sprite[i * 3 + c] ?? 0) * gain + offset;
        frame[d + c] = Math.min(255, Math.max(0, (frame[d + c] ?? 0) * (1 - m) + value * m));
      }
    }
  }
};

/** Frame `index` of the remake as RGB bytes. */
export const composeFrame = (
  template: WhoIsThisTemplate,
  pixels: TemplatePixels,
  index: number,
  picture: Picture,
  { scale, word }: { scale: number; word: string },
) => {
  const { width, height } = template;
  const entry = template.frames[index];
  const frameBytes = width * height * 3;
  const frame = pixels.frames.slice(index * frameBytes, (index + 1) * frameBytes);
  if (!entry) {
    return frame;
  }
  if (entry.patch) {
    drawCrop(frame, width, pixels.patches, template.patches.size[0], 3, entry.patch);
  }
  if (entry.face) {
    pastePicture(frame, width, height, picture, entry.face, entry.regrade, scale);
  }
  const overlay = entry.overlays?.[word];
  if (overlay) {
    drawCrop(frame, width, pixels.overlays, template.overlays.size[0], 4, overlay);
  }
  return frame;
};
