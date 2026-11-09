import { blurField, dilateField, gaussianBlur, resizeArea, roundHalfEven, type Field } from './pixelOps';
import type { GlyphSet, TextLayer } from './textLayer';

/**
 * Remakes who_is_this_kid.gif with a picture over the kid's face and "KID" swapped for any word, the
 * way tools/who-is-this-kid/who_is_this.py does.
 *
 * tools/who-is-this-kid/build_template.py did everything that depends on neither the picture nor the
 * word: it tracked the face, painted "KID" out (`patch`), fitted the end-of-clip colour regrade, and
 * measured each caption frame. Per frame this module draws, in the script's order: source frame,
 * patch, picture, the caption pixels restored over the picture, then the word with its glow (and the
 * '?' or the copied '*'). Arithmetic follows the script, including NumPy's float32/float64 types and
 * `astype(np.uint8)` truncation.
 */

/** A crop stored in a sheet image at `(0, sheetY)` that belongs at `(x, y)` in the frame. */
export interface SheetCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  sheetY: number;
}

/** "WHO IS THIS KID?" fading in: how far the word and the '?' have faded in (1 = fully). */
export interface QuestionCaption {
  kind: 'question';
  wordAlpha: number;
  markAlpha: number;
}

/** "*RANDOM KID*" zooming in: its measured extent, red strength, baseline row and colour (RGB). */
export interface LabelCaption {
  kind: 'label';
  left: number;
  right: number;
  strength: number;
  baseline: number;
  color: [number, number, number];
}

export interface TemplateFrame {
  /** Smoothed face box: centre x, centre y, width. */
  face?: [number, number, number];
  /** Per RGB channel `[gain, offset]` applied to the picture to follow the clip's white flash and regrade. */
  regrade?: [number, number][];
  patch?: SheetCrop;
  caption?: QuestionCaption | LabelCaption;
}

export interface WhoIsThisKidTemplate {
  width: number;
  height: number;
  fps: number;
  source: string;
  patches: { file: string; size: [number, number] };
  /** The glyph data file (see textLayer.ts). */
  glyphs: string;
  /** Where "*RANDOM KID*" sits in its final frame, which the zooming frames are mapped against. */
  label: { referenceLeft: number; referenceRight: number; referenceBaseline: number };
  /** The frame the page places the picture on (its still is src/assets/who-is-this-kid/editor-frame.jpg). */
  editor: { frame: number };
  frames: TemplateFrame[];
}

/** The template's images decoded: every source frame as RGB and `patches` as RGB. */
export interface TemplatePixels {
  frames: Uint8Array;
  patches: Uint8Array;
}

export const pictureShapes = ['auto', 'circle', 'square', 'alpha'] as const;
export type PictureShape = (typeof pictureShapes)[number];

/** The picture ready to paste: RGB bytes and a 0-1 paste mask, both `width` x `height`. */
export interface Picture {
  width: number;
  height: number;
  rgb: Uint8Array;
  mask: Float32Array;
}

/** The part of the picture that is used, in the picture's whole pixels. */
export interface PictureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PictureOptions {
  crop: PictureCrop;
  /** auto: the picture's own transparency if it has any, else a feathered circle (an ellipse for a rectangle). */
  shape: PictureShape;
  /** Pictures wider than this are shrunk to it first; see `pictureSizeLimit`. */
  maxSize: number;
}

/** Where the picture goes relative to the tracked face, in face widths. */
export interface PicturePlacement {
  /** Picture width; 1.6 covers the face with some margin, as the original script did. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** The largest centred square: the original script's crop. */
export const centeredCrop = (width: number, height: number): PictureCrop => {
  const size = Math.min(width, height);
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), width: size, height: size };
};

/**
 * The widest picture worth keeping for a paste `scale`: four times the widest pasted picture. Shrinking
 * a phone photo to it first keeps each frame's resize and the edge feathering fast without visibly
 * changing the result.
 */
export const pictureSizeLimit = (template: WhoIsThisKidTemplate, scale: number) =>
  4 * Math.max(...template.frames.map((frame) => (frame.face ? Math.trunc(frame.face[2] * scale) : 0)));

/** What `auto` means for this crop: the picture's own transparency if over 2% of it is see-through. */
export const resolvePictureShape = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  crop: PictureCrop,
  shape: PictureShape,
) => {
  if (shape !== 'auto') {
    return shape;
  }
  let translucent = 0;
  for (let row = crop.y; row < crop.y + crop.height; row += 1) {
    for (let column = crop.x; column < crop.x + crop.width; column += 1) {
      const inside = column >= 0 && column < width && row >= 0 && row < height;
      // Past the image edge counts as transparent, as Pillow's crop pads it.
      if (!inside || (rgba[(row * width + column) * 4 + 3] ?? 0) / 255 < 0.99) {
        translucent += 1;
      }
    }
  }
  return translucent / (crop.width * crop.height) > 0.02 ? 'alpha' : 'circle';
};

/**
 * The original script's `load_pfp`, from RGBA pixels (EXIF rotation already applied by the browser).
 * The script only took squares; a rectangular crop gets the ellipse that its circle stretches to.
 */
export const preparePicture = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  { crop, shape, maxSize }: PictureOptions,
): Picture => {
  const cropWidth = Math.max(1, crop.width);
  const cropHeight = Math.max(1, crop.height);

  // Like Pillow's crop, anything past the image edge is transparent black.
  let rgb = new Uint8Array(cropWidth * cropHeight * 3);
  let alpha = new Float32Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const sx = crop.x + x;
      const sy = crop.y + y;
      const i = y * cropWidth + x;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const s = (sy * width + sx) * 4;
        rgb[i * 3] = rgba[s] ?? 0;
        rgb[i * 3 + 1] = rgba[s + 1] ?? 0;
        rgb[i * 3 + 2] = rgba[s + 2] ?? 0;
        alpha[i] = (rgba[s + 3] ?? 0) / 255;
      }
    }
  }
  const resolvedShape = resolvePictureShape(rgba, width, height, crop, shape);

  let outWidth = cropWidth;
  let outHeight = cropHeight;
  if (cropWidth > maxSize) {
    outWidth = maxSize;
    outHeight = Math.max(1, Math.round((cropHeight * maxSize) / cropWidth));
    rgb = resizeArea(rgb, cropWidth, cropHeight, 3, outWidth, outHeight);
    alpha = resizeArea(alpha, cropWidth, cropHeight, 1, outWidth, outHeight);
  }
  if (resolvedShape === 'alpha') {
    return { width: outWidth, height: outHeight, rgb, mask: alpha };
  }

  // A shrunk picture gets the circle and feather the full-size crop would have had, scaled down.
  const factor = outWidth / cropWidth;
  const side = Math.min(cropWidth, cropHeight);
  const shapeMask = new Float32Array(outWidth * outHeight);
  if (resolvedShape === 'square') {
    shapeMask.fill(1);
  } else {
    const margin = Math.max(2, Math.floor(side / 60));
    const centerX = Math.floor(cropWidth / 2) * factor;
    const centerY = Math.floor(cropHeight / 2) * factor;
    const radiusX = (Math.floor(cropWidth / 2) - margin) * factor;
    const radiusY = (Math.floor(cropHeight / 2) - margin) * factor;
    for (let y = 0; y < outHeight; y += 1) {
      for (let x = 0; x < outWidth; x += 1) {
        // On a square this is cv2.circle's filled disc: exactly the pixels within the radius.
        if (((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 <= 1) {
          shapeMask[y * outWidth + x] = 1;
        }
      }
    }
  }
  const mask = gaussianBlur(shapeMask, outWidth, outHeight, Math.max(1, side / 90) * factor);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = (mask[i] ?? 0) * (alpha[i] ?? 0);
  }
  return { width: outWidth, height: outHeight, rgb, mask };
};

const f32 = Math.fround;

/** `np.clip(value, 0, 255).astype(np.uint8)`. */
const toByte = (value: number) => (value <= 0 ? 0 : value >= 255 ? 255 : Math.trunc(value));

/** `img * (1 - a) + color * a` in float32 (`img`, `color` and `a` already float32 values). */
const mixF32 = (img: number, color: number, a: number) => f32(f32(img * f32(1 - a)) + f32(color * a));

/** Copy a sheet crop's RGB pixels into the frame. */
const drawCrop = (frame: Uint8Array, frameWidth: number, sheet: Uint8Array, sheetWidth: number, crop: SheetCrop) => {
  for (let y = 0; y < crop.height; y += 1) {
    const from = (crop.sheetY + y) * sheetWidth * 3;
    frame.set(sheet.subarray(from, from + crop.width * 3), ((crop.y + y) * frameWidth + crop.x) * 3);
  }
};

/** The original script's `paste_face`, moved by the placement's offsets, with the template's regrade. */
const pastePicture = (
  frame: Uint8Array,
  width: number,
  height: number,
  picture: Picture,
  face: [number, number, number],
  regrade: [number, number][] | undefined,
  { scale, offsetX, offsetY }: PicturePlacement,
) => {
  const [cx, cy, s] = face;
  // The picture's width follows the face; its height keeps the crop's proportions.
  const spriteWidth = Math.max(4, Math.trunc(s * scale));
  const spriteHeight = Math.max(4, Math.trunc((s * scale * picture.height) / picture.width));
  const x0 = roundHalfEven(cx + offsetX * s - spriteWidth / 2);
  const y0 = roundHalfEven(cy + offsetY * s - spriteHeight / 2 - s * 0.08);
  const sprite = resizeArea(picture.rgb, picture.width, picture.height, 3, spriteWidth, spriteHeight);
  const mask = resizeArea(picture.mask, picture.width, picture.height, 1, spriteWidth, spriteHeight);
  // spr[..., c] * float(gain) + float(offset) on a float32 array: both scalars become float32.
  const gains = (regrade ?? []).map(([gain, offset]) => [f32(gain), f32(offset)] as const);

  for (let y = Math.max(y0, 0); y < Math.min(y0 + spriteHeight, height); y += 1) {
    for (let x = Math.max(x0, 0); x < Math.min(x0 + spriteWidth, width); x += 1) {
      const i = (y - y0) * spriteWidth + (x - x0);
      const m = mask[i] ?? 0;
      const d = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const [gain, offset] = gains[c] ?? [1, 0];
        const value = regrade ? f32(f32((sprite[i * 3 + c] ?? 0) * gain) + offset) : (sprite[i * 3 + c] ?? 0);
        frame[d + c] = toByte(mixF32(frame[d + c] ?? 0, value, m));
      }
    }
  }
};

/**
 * The script's `composite(img, alpha, color)`. NumPy keeps `alpha` in float32 unless the script
 * multiplied it by a NumPy float64 scalar; `Float64Array` data marks that case.
 */
const composite = (frame: Uint8Array, width: number, alpha: Field, color: readonly number[]) => {
  const float32 = alpha.data instanceof Float32Array;
  const rgb = color.map((value) => f32(value));
  for (let row = 0; row < alpha.height; row += 1) {
    for (let column = 0; column < alpha.width; column += 1) {
      const a = alpha.data[row * alpha.width + column] ?? 0;
      if (a === 0) {
        continue;
      }
      const d = ((alpha.y + row) * width + alpha.x + column) * 3;
      for (let c = 0; c < 3; c += 1) {
        const img = frame[d + c] ?? 0;
        const color_ = rgb[c] ?? 0;
        frame[d + c] = toByte(float32 ? mixF32(img, color_, a) : img * (1 - a) + color_ * a);
      }
    }
  }
};

/** `field * scalar` with a Python float scalar: NumPy casts it to float32 and stays in float32. */
const timesPythonFloat = (field: Field, scalar: number): Field => {
  const s = f32(scalar);
  return { ...field, data: Float32Array.from(field.data, (v) => v * s) };
};

/** `field * scalar` with a NumPy float64 scalar: the result is float64. */
const timesNumpyFloat = (field: Field, scalar: number): Field => ({
  ...field,
  data: Float64Array.from(field.data, (v) => v * scalar),
});

/**
 * `field * min(1.0, ratio)`: `min` returns the Python float 1.0 for a full fade-in (float32 maths)
 * and the NumPy float64 ratio otherwise.
 */
const timesFadeIn = (field: Field, ratio: number) => (ratio < 1 ? timesNumpyFloat(field, ratio) : field);

const clip01 = (field: Field): Field => ({
  ...field,
  data: Float32Array.from(field.data, (v) => Math.min(Math.max(v, 0), 1)),
});

/** The script's `glow(alpha, grow, blur)`: dilate, then blur. */
const glow = (field: Field, grow: number, sigma: number, width: number, height: number) =>
  blurField(dilateField(field, grow, width, height), sigma, width, height);

/** A 0/1 field of the frame pixels inside `[x0, x1) x [y0, y1)` that pass `test`. */
const maskField = (
  source: Uint8Array,
  width: number,
  [x0, y0, x1, y1]: [number, number, number, number],
  test: (r: number, g: number, b: number, x: number, y: number) => boolean,
): Field => {
  const data = new Float32Array((x1 - x0) * (y1 - y0));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const s = (y * width + x) * 3;
      if (test(source[s] ?? 0, source[s + 1] ?? 0, source[s + 2] ?? 0, x, y)) {
        data[(y - y0) * (x1 - x0) + x - x0] = 1;
      }
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, data };
};

/** `img = np.clip(img * (1 - rmf) + orig * rmf, 0, 255)` with the script's feathered restore mask. */
const restoreCaption = (frame: Uint8Array, source: Uint8Array, width: number, height: number, restore: Field) => {
  const rmf = blurField(dilateField(restore, 3, width, height), 0.7, width, height);
  for (let row = 0; row < rmf.height; row += 1) {
    for (let column = 0; column < rmf.width; column += 1) {
      const r = rmf.data[row * rmf.width + column] ?? 0;
      if (r === 0) {
        continue;
      }
      const d = ((rmf.y + row) * width + rmf.x + column) * 3;
      for (let c = 0; c < 3; c += 1) {
        frame[d + c] = toByte(mixF32(frame[d + c] ?? 0, source[d + c] ?? 0, r));
      }
    }
  }
};

// who_is_this.py's caption constants, RGB.
const QUESTION_BOX: [number, number, number, number] = [0, 272, 293, 316];
const QUESTION_GLOW: [number, number, number] = [75, 0, 70];
const QUESTION_WORD: [number, number, number] = [215, 4, 215];
const QUESTION_MARK_SHADOW: [number, number, number] = [40, 30, 40];
const QUESTION_MARK: [number, number, number] = [245, 245, 245];
const LABEL_GLOW: [number, number, number] = [90, 10, 25];
const LABEL_ROWS = [118, 166] as const;

/** The zooming caption's mapping from its final frame's x to this frame's (`mp` in the script). */
const labelGeometry = (template: WhoIsThisKidTemplate, caption: LabelCaption) => {
  const { referenceLeft, referenceRight } = template.label;
  const scale = (caption.right - caption.left) / (referenceRight - referenceLeft);
  const centre = (caption.left + caption.right) / 2;
  const map = (x: number) => centre + (x - (referenceLeft + referenceRight) / 2) * scale;
  return { scale, map };
};

export type WordProblem =
  { kind: 'empty' } | { kind: 'unsupported'; characters: string[] } | { kind: 'too-wide' } | { kind: 'no-ink' };

/** The script's `args.word.upper()`, from the word as typed (composed first, so accents stay one character). */
export const captionWord = (typed: string) => typed.normalize('NFC').trim().toUpperCase();

/**
 * The word drawn into each caption frame. Layers depend only on the word and the frame's caption, so
 * they are computed once per word and shared by every render.
 */
export interface Captions {
  /** Why the word cannot be drawn the way the script would draw it, or null. */
  problem: WordProblem | null;
  draw: (frame: Uint8Array, source: Uint8Array, index: number) => void;
}

export const createCaptions = (template: WhoIsThisKidTemplate, glyphs: GlyphSet, word: string): Captions => {
  const { width, height } = template;
  const layers = new Map<string, TextLayer>();
  const layer = (text: string, capHeight: number, x0: number, baseY: number, track: number) => {
    const key = [text, capHeight, x0, baseY, track].join('|');
    let value = layers.get(key);
    if (!value) {
      value = glyphs.layer(text, capHeight, x0, baseY, track, width, height);
      layers.set(key, value);
    }
    return value;
  };

  const question = () => {
    const text = layer(word, 19, 302, 307.5, 2.2);
    return { text, mark: layer('?', 19, text.end + 4.5, 307.5, 0) };
  };

  const label = (caption: LabelCaption) => {
    const { scale, map } = labelGeometry(template, caption);
    const sharp = layer(
      word,
      23 * scale,
      map(244),
      154 + (caption.baseline - template.label.referenceBaseline),
      2 * scale,
    );
    // (sharp > 0.3).any(0).nonzero()[0].max(): the word's last inked column.
    const threshold = f32(0.3);
    let last = -1;
    for (let column = sharp.alpha.width - 1; column >= 0 && last < 0; column -= 1) {
      for (let row = 0; row < sharp.alpha.height; row += 1) {
        if ((sharp.alpha.data[row * sharp.alpha.width + column] ?? 0) > threshold) {
          last = sharp.alpha.x + column;
          break;
        }
      }
    }
    const starLeft = Math.trunc(map(58));
    const starRight = Math.trunc(map(74)) + 1;
    const starX = last < 0 ? -1 : last + roundHalfEven(2 * scale);
    return { map, sharp, last, starLeft, starRight, starX };
  };

  const problem = ((): WordProblem | null => {
    if (!word) {
      return { kind: 'empty' };
    }
    const characters = glyphs.unsupported(word);
    if (characters.length) {
      return { kind: 'unsupported', characters };
    }
    for (const frame of template.frames) {
      if (frame.caption?.kind === 'question') {
        const { text, mark } = question();
        if (text.clipped || mark.clipped) {
          return { kind: 'too-wide' };
        }
      } else if (frame.caption?.kind === 'label') {
        const { sharp, last, starLeft, starRight, starX } = label(frame.caption);
        if (last < 0) {
          return { kind: 'no-ink' };
        }
        // The script copies the '*' after the word; it has to fit in the frame too.
        if (sharp.clipped || starX + (starRight - starLeft) > width) {
          return { kind: 'too-wide' };
        }
      }
    }
    return null;
  })();

  const draw = (frame: Uint8Array, source: Uint8Array, index: number) => {
    const caption = template.frames[index]?.caption;
    if (!caption || problem) {
      return;
    }
    if (caption.kind === 'question') {
      const restore = maskField(source, width, QUESTION_BOX, (r, g, b) => {
        const pink = r > 150 && b > 130 && g < 120;
        const white = Math.min(r, g, b) > 175;
        return pink || white;
      });
      restoreCaption(frame, source, width, height, restore);

      const { text, mark } = question();
      const glowAlpha = clip01(timesPythonFloat(glow(text.alpha, 5, 3, width, height), 0.85));
      composite(frame, width, timesFadeIn(glowAlpha, caption.wordAlpha), QUESTION_GLOW);
      composite(frame, width, timesFadeIn(text.alpha, caption.wordAlpha), QUESTION_WORD);
      const shadow = timesPythonFloat(blurField(dilateField(mark.alpha, 3, width, height), 2, width, height), 0.35);
      composite(frame, width, timesFadeIn(shadow, caption.markAlpha), QUESTION_MARK_SHADOW);
      composite(frame, width, timesFadeIn(mark.alpha, caption.markAlpha), QUESTION_MARK);
      return;
    }

    const { map, sharp, starLeft, starRight, starX } = label(caption);
    const cutLeft = Math.trunc(map(240));
    const cutRight = Math.trunc(map(316)) + 2;
    const arrowRight = Math.trunc(map(252));
    const restore = maskField(source, width, [0, 0, width, 245], (r, g, b, x, y) => {
      if (r - g <= 60 || r - b <= 40) return false;
      // "KID" stays painted out, and below the caption only the arrow is restored, not the kid's face.
      if (y < LABEL_ROWS[1] && x >= cutLeft && x < cutRight) return false;
      return y < LABEL_ROWS[1] || x < arrowRight;
    });
    restoreCaption(frame, source, width, height, restore);

    // fade = np.clip((strength - 40) / 130.0, 0, 1) is a NumPy float64, so both products are float64.
    const fade = Math.min(Math.max((caption.strength - 40) / 130, 0), 1);
    let alpha: Field = sharp.alpha;
    if (fade < 0.95) {
      alpha = timesNumpyFloat(blurField(sharp.alpha, 0.3 + 2 * (1 - fade), width, height), 0.55 + 0.45 * fade);
    }
    composite(
      frame,
      width,
      timesNumpyFloat(clip01(timesPythonFloat(glow(sharp.alpha, 5, 3.5, width, height), 0.7)), fade),
      LABEL_GLOW,
    );
    composite(frame, width, alpha, caption.color);

    // The trailing '*': the caption's own leading asterisk, copied after the word.
    const [top, bottom] = LABEL_ROWS;
    const starWidth = Math.min(starRight - starLeft, width - starX);
    const rows = bottom - top;
    const starMask = new Float32Array(rows * (starRight - starLeft));
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < starRight - starLeft; x += 1) {
        const s = ((top + y) * width + starLeft + x) * 3;
        starMask[y * (starRight - starLeft) + x] =
          (source[s] ?? 0) - (source[s + 1] ?? 0) > 0.6 * caption.strength ? 1 : 0;
      }
    }
    const pm = gaussianBlur(starMask, starRight - starLeft, rows, 0.6);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < starWidth; x += 1) {
        const m = pm[y * (starRight - starLeft) + x] ?? 0;
        const s = ((top + y) * width + starLeft + x) * 3;
        const d = ((top + y) * width + starX + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          frame[d + c] = toByte(mixF32(frame[d + c] ?? 0, source[s + c] ?? 0, m));
        }
      }
    }
  };

  return { problem, draw };
};

/** Frame `index` of the remake as RGB bytes. */
export const composeFrame = (
  template: WhoIsThisKidTemplate,
  pixels: TemplatePixels,
  index: number,
  picture: Picture,
  { placement, captions }: { placement: PicturePlacement; captions: Captions },
) => {
  const { width, height } = template;
  const entry = template.frames[index];
  const frameBytes = width * height * 3;
  const source = pixels.frames.subarray(index * frameBytes, (index + 1) * frameBytes);
  const frame = source.slice();
  if (!entry) {
    return frame;
  }
  if (entry.patch) {
    drawCrop(frame, width, pixels.patches, template.patches.size[0], entry.patch);
  }
  if (entry.face) {
    pastePicture(frame, width, height, picture, entry.face, entry.regrade, placement);
  }
  captions.draw(frame, source, index);
  return frame;
};
