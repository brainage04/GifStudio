import { emptyField, roundHalfEven, type Field } from './pixelOps';

/**
 * who_is_this.py's `Text.layer`, reproduced exactly: Pillow 12 drawing one character at a time with
 * FreeType 2.14 at 4x, then reducing the 4x canvas with `Image.LANCZOS`.
 *
 * tools/who-is-this-kid/build_template.py exports the font as FreeType loads it (glyphs.json) and
 * checks, for every exported character and caption size, that Pillow draws exactly FreeType's bitmap
 * where `layer` below puts it. At the caption sizes the font's hinting program switches itself off,
 * so a glyph bitmap is its scaled outline run through FreeType's anti-aliasing rasteriser
 * (src/smooth/ftgrays.c), ported below with its integer arithmetic.
 */

/** glyphs.json as build_template.py writes it. */
export interface GlyphData {
  font: string;
  weight: number;
  /** Each caption size in 4x pixels, with FreeType's 16.16 scale from font units to 26.6 pixels. */
  sizes: { px: number; xScale: number; yScale: number }[];
  /**
   * `[codepoint, contour end indices, points as deltas from the previous point (unrounded 26.6 font
   * units), on-curve flags ('1'/'0'), advance per size (26.6 pixels), per size [[contour, dx, dy]]]`.
   */
  glyphs: [number, number[], number[], string, number[], [number, number, number][][]][];
}

interface Glyph {
  ends: number[];
  /** Absolute unrounded points, x and y interleaved. */
  points: number[];
  onCurve: boolean[];
  advances: number[];
  offsets: [number, number, number][][];
}

interface GlyphBitmap {
  left: number;
  top: number;
  width: number;
  rows: number;
  /** Rows top to bottom. */
  pixels: Uint8Array;
}

/** FreeType's `FT_MulFix`: `a * b / 0x10000`, rounded half away from zero. */
const mulFix = (a: number, b: number) => {
  const product = Math.floor((Math.abs(a) * Math.abs(b) + 0x8000) / 0x10000);
  return a < 0 !== b < 0 ? -product : product;
};

// ---------------------------------------------------------------- FreeType's gray rasteriser

const PIXEL_BITS = 8;
const ONE_PIXEL = 1 << PIXEL_BITS;
const TWO_POW_32 = 2 ** 32;

/** `FT_UDIV(a, b)` with `b ## _r = 0xFFFFFFFF / b`: `(a * r) >> 32` on 64-bit unsigned values. */
const udiv = (a: number, reciprocal: number) => {
  const high = Math.floor(reciprocal / 0x10000);
  const low = reciprocal % 0x10000;
  return Math.floor((a * high + Math.floor((a * low) / 0x10000)) / 0x10000);
};

/**
 * `gray_raster_render` for a non-zero-winding outline in 26.6 bitmap coordinates (y up from the
 * bottom row), into a `width` x `rows` bitmap.
 */
const rasterize = (points: number[], onCurve: boolean[], ends: number[], width: number, rows: number) => {
  // One cell per pixel plus one for everything clipped on the left (FreeType's `min_ex - 1`).
  const stride = width + 1;
  const cover = new Float64Array(rows * stride);
  const area = new Float64Array(rows * stride);
  let cell = -1;
  let rasX = 0;
  let rasY = 0;

  const setCell = (ex: number, ey: number) => {
    cell = ey < 0 || ey >= rows || ex >= width ? -1 : ey * stride + Math.max(ex, -1) + 1;
  };
  const integrate = (a: number, b: number) => {
    if (cell >= 0) {
      cover[cell] = (cover[cell] ?? 0) + a;
      area[cell] = (area[cell] ?? 0) + a * b;
    }
  };

  // gray_render_line, the FT_INT64 variant.
  const renderLine = (toX: number, toY: number) => {
    let ey1 = rasY >> PIXEL_BITS;
    const ey2 = toY >> PIXEL_BITS;
    if ((ey1 >= rows && ey2 >= rows) || (ey1 < 0 && ey2 < 0)) {
      rasX = toX;
      rasY = toY;
      return;
    }
    let ex1 = rasX >> PIXEL_BITS;
    const ex2 = toX >> PIXEL_BITS;
    let fx1 = rasX & (ONE_PIXEL - 1);
    let fy1 = rasY & (ONE_PIXEL - 1);
    let fx2: number;
    let fy2: number;
    const dx = toX - rasX;
    const dy = toY - rasY;

    if (ex1 === ex2 && ey1 === ey2) {
      // inside one cell
    } else if (dy === 0) {
      setCell(ex2, ey2);
      rasX = toX;
      rasY = toY;
      return;
    } else if (dx === 0) {
      if (dy > 0) {
        do {
          fy2 = ONE_PIXEL;
          integrate(fy2 - fy1, fx1 * 2);
          fy1 = 0;
          ey1 += 1;
          setCell(ex1, ey1);
        } while (ey1 !== ey2);
      } else {
        do {
          fy2 = 0;
          integrate(fy2 - fy1, fx1 * 2);
          fy1 = ONE_PIXEL;
          ey1 -= 1;
          setCell(ex1, ey1);
        } while (ey1 !== ey2);
      }
    } else {
      let prod = dx * fy1 - dy * fx1;
      const dxR = ex1 !== ex2 ? Math.trunc(0xffffffff / dx) : 0;
      const dyR = ey1 !== ey2 ? Math.trunc(0xffffffff / dy) : 0;
      do {
        if (prod - dx * ONE_PIXEL > 0 && prod <= 0) {
          // left
          fx2 = 0;
          fy2 = udiv(-prod, -dxR);
          prod -= dy * ONE_PIXEL;
          integrate(fy2 - fy1, fx1 + fx2);
          fx1 = ONE_PIXEL;
          fy1 = fy2;
          ex1 -= 1;
        } else if (prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0 && prod - dx * ONE_PIXEL <= 0) {
          // up
          prod -= dx * ONE_PIXEL;
          fx2 = udiv(-prod, dyR);
          fy2 = ONE_PIXEL;
          integrate(fy2 - fy1, fx1 + fx2);
          fx1 = fx2;
          fy1 = 0;
          ey1 += 1;
        } else if (prod + dy * ONE_PIXEL >= 0 && prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0) {
          // right
          prod += dy * ONE_PIXEL;
          fx2 = ONE_PIXEL;
          fy2 = udiv(prod, dxR);
          integrate(fy2 - fy1, fx1 + fx2);
          fx1 = 0;
          fy1 = fy2;
          ex1 += 1;
        } else {
          // down
          fx2 = udiv(prod, -dyR);
          fy2 = 0;
          prod += dx * ONE_PIXEL;
          integrate(fy2 - fy1, fx1 + fx2);
          fx1 = fx2;
          fy1 = ONE_PIXEL;
          ey1 -= 1;
        }
        setCell(ex1, ey1);
      } while (ex1 !== ex2 || ey1 !== ey2);
    }

    fx2 = toX & (ONE_PIXEL - 1);
    fy2 = toY & (ONE_PIXEL - 1);
    integrate(fy2 - fy1, fx1 + fx2);
    rasX = toX;
    rasY = toY;
  };

  // gray_render_conic, the FT_INT64 forward-differencing variant; inputs in 26.6.
  const renderConic = (controlX: number, controlY: number, toX: number, toY: number) => {
    const p0x = rasX;
    const p0y = rasY;
    const p1x = controlX * 4;
    const p1y = controlY * 4;
    const p2x = toX * 4;
    const p2y = toY * 4;
    if (
      (p0y >> PIXEL_BITS >= rows && p1y >> PIXEL_BITS >= rows && p2y >> PIXEL_BITS >= rows) ||
      (p0y >> PIXEL_BITS < 0 && p1y >> PIXEL_BITS < 0 && p2y >> PIXEL_BITS < 0)
    ) {
      rasX = p2x;
      rasY = p2y;
      return;
    }
    const bx = p1x - p0x;
    const by = p1y - p0y;
    const ax = p2x - p1x - bx;
    const ay = p2y - p1y - by;
    let deviation = Math.max(Math.abs(ax), Math.abs(ay));
    if (deviation <= ONE_PIXEL / 4) {
      renderLine(p2x, p2y);
      return;
    }
    let shift = 16;
    do {
      deviation >>= 2;
      shift -= 1;
    } while (deviation > ONE_PIXEL / 4);
    let count = 0x10000 >>> shift;

    let rx = ax * 2 ** (shift + shift);
    let ry = ay * 2 ** (shift + shift);
    let qx = bx * 2 ** (shift + 17) + rx;
    let qy = by * 2 ** (shift + 17) + ry;
    rx *= 2;
    ry *= 2;
    let px = p0x * TWO_POW_32;
    let py = p0y * TWO_POW_32;
    do {
      px += qx;
      py += qy;
      qx += rx;
      qy += ry;
      renderLine(Math.floor(px / TWO_POW_32), Math.floor(py / TWO_POW_32));
      count -= 1;
    } while (count);
  };

  const moveTo = (x: number, y: number) => {
    rasX = x * 4;
    rasY = y * 4;
    setCell(rasX >> PIXEL_BITS, rasY >> PIXEL_BITS);
  };

  // FT_Outline_Decompose for TrueType outlines (on-curve points and conic control points only).
  let first = 0;
  for (const last of ends) {
    const px = (i: number) => points[i * 2] ?? 0;
    const py = (i: number) => points[i * 2 + 1] ?? 0;
    let startX = px(first);
    let startY = py(first);
    let point = first;
    let limit = last;
    if (!onCurve[first]) {
      if (onCurve[last]) {
        startX = px(last);
        startY = py(last);
        limit -= 1;
      } else {
        startX = Math.trunc((startX + px(last)) / 2);
        startY = Math.trunc((startY + py(last)) / 2);
      }
      point -= 1;
    }
    moveTo(startX, startY);

    let closed = false;
    while (point < limit) {
      point += 1;
      if (onCurve[point]) {
        renderLine(px(point) * 4, py(point) * 4);
        continue;
      }
      let controlX = px(point);
      let controlY = py(point);
      for (;;) {
        if (point < limit) {
          point += 1;
          const x = px(point);
          const y = py(point);
          if (onCurve[point]) {
            renderConic(controlX, controlY, x, y);
            break;
          }
          renderConic(controlX, controlY, Math.trunc((controlX + x) / 2), Math.trunc((controlY + y) / 2));
          controlX = x;
          controlY = y;
          continue;
        }
        renderConic(controlX, controlY, startX, startY);
        closed = true;
        break;
      }
      if (closed) {
        break;
      }
    }
    if (!closed) {
      renderLine(startX * 4, startY * 4);
    }
    first = last + 1;
  }

  // gray_sweep with the non-zero fill rule. Visiting every pixel as a cell gives the same bytes as
  // FreeType's sparse cell list, whose gaps it fills with the running cover.
  const coverage = (value: number) => {
    let c = Math.floor(value / 2 ** (PIXEL_BITS * 2 + 1 - 8));
    if (c < 0) {
      c = -c - 1;
    }
    return c > 255 ? 255 : c;
  };
  const pixels = new Uint8Array(width * rows);
  for (let y = 0; y < rows; y += 1) {
    const line = (rows - 1 - y) * width;
    let run = 0;
    for (let x = -1; x < width; x += 1) {
      const index = y * stride + x + 1;
      run += (cover[index] ?? 0) * ONE_PIXEL * 2;
      if (x >= 0) {
        pixels[line + x] = coverage(run - (area[index] ?? 0));
      }
    }
  }
  return pixels;
};

// ---------------------------------------------------------------- Pillow's Lanczos reduce

const PRECISION_BITS = 32 - 8 - 2;

const sinc = (value: number) => {
  if (value === 0) {
    return 1;
  }
  const angle = value * Math.PI;
  return Math.sin(angle) / angle;
};

const lanczos = (x: number) => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);

interface Coefficients {
  /** First source index and tap count per output index. */
  bounds: Int32Array;
  /** `ksize` fixed-point weights per output index. */
  weights: Int32Array;
  ksize: number;
}

/** Resample.c's `precompute_coeffs` and `normalize_coeffs_8bpc` for Lanczos over a whole axis. */
const coefficients = (inSize: number, outSize: number): Coefficients => {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = 3 * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const weights = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx += 1) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterScale;
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const xmax = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
    let total = 0;
    for (let x = 0; x < xmax; x += 1) {
      const w = lanczos((x + xmin - center + 0.5) * ss);
      k[x] = w;
      total += w;
    }
    for (let x = 0; x < xmax; x += 1) {
      const w = total !== 0 ? (k[x] ?? 0) / total : (k[x] ?? 0);
      weights[xx * ksize + x] = Math.trunc(w < 0 ? -0.5 + w * (1 << PRECISION_BITS) : 0.5 + w * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, weights, ksize };
};

/** Resample.c's `clip8`: the 22-bit fixed-point sum to a byte. */
const clip8 = (sum: number) => {
  const value = Math.floor(sum / (1 << PRECISION_BITS));
  return value < 0 ? 0 : value > 255 ? 255 : value;
};

/** The output indices whose taps reach source indices `from` to `to` (exclusive). */
const reach = (c: Coefficients, outSize: number, from: number, to: number) => {
  let first = -1;
  let last = -1;
  for (let i = 0; i < outSize; i += 1) {
    const start = c.bounds[i * 2] ?? 0;
    const end = start + (c.bounds[i * 2 + 1] ?? 0);
    if (start < to && end > from) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return [first, last + 1] as const;
};

// ---------------------------------------------------------------- Pillow's per-character drawing

/** Pillow's `PIXEL()`: 26.6 to whole pixels, halves up. */
const pixelRound = (value: number) => Math.floor((value + 32) / 64);

/** C's `round()`: halves away from zero. */
const cRound = (value: number) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);

/** Pillow's `BLEND(mask, out, 255)` for an "L" image: `DIV255(out * (255 - mask) + 255 * mask)`. */
const blend255 = (out: number, mask: number) => {
  const tmp = out * (255 - mask) + 255 * mask + 128;
  return ((tmp >> 8) + tmp) >> 8;
};

export interface TextLayer {
  /** `np.asarray(im, np.float32) / 255`. */
  alpha: Field;
  /** Where the pen ended, in frame pixels: `Text.layer`'s second return value. */
  end: number;
  /** Whether part of a glyph fell outside the frame (Pillow clips it). */
  clipped: boolean;
}

export interface GlyphSet {
  /** The characters of `text` the glyph data cannot draw exactly as the script does. */
  unsupported: (text: string) => string[];
  /** `Text.layer(text, cap_h, x0, base_y, track)` on a `frameWidth` x `frameHeight` frame. */
  layer: (
    text: string,
    capHeight: number,
    x0: number,
    baseY: number,
    track: number,
    frameWidth: number,
    frameHeight: number,
  ) => TextLayer;
}

const S = 4;

export const createGlyphSet = (data: GlyphData): GlyphSet => {
  const glyphs = new Map<number, Glyph>();
  for (const [codepoint, ends, deltas, flags, advances, offsets] of data.glyphs) {
    const points: number[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < deltas.length; i += 2) {
      x += deltas[i] ?? 0;
      y += deltas[i + 1] ?? 0;
      points.push(x, y);
    }
    glyphs.set(codepoint, { ends, points, onCurve: [...flags].map((flag) => flag === '1'), advances, offsets });
  }
  const sizeIndex = new Map(data.sizes.map((size, index) => [size.px, index]));
  const bitmaps = new Map<string, GlyphBitmap>();
  const axes = new Map<string, Coefficients>();

  /** FT_Load_Glyph + FT_Render_Glyph at size `index`: the bitmap and its offset from the origin. */
  const glyphBitmap = (codepoint: number, glyph: Glyph, index: number): GlyphBitmap => {
    const key = `${codepoint}:${index}`;
    const cached = bitmaps.get(key);
    if (cached) {
      return cached;
    }
    const size = data.sizes[index];
    if (!size) {
      throw new Error(`The glyph data has no size ${index}.`);
    }
    // Scale as ttgload.c does for a variation instance, then add composite components' offsets.
    const points = glyph.points.map((value, i) =>
      Math.floor((mulFix(value, i % 2 === 0 ? size.xScale : size.yScale) + 32) / 64),
    );
    for (const [contour, dx, dy] of glyph.offsets[index] ?? []) {
      const from = contour === 0 ? 0 : (glyph.ends[contour - 1] ?? 0) + 1;
      for (let i = from; i <= (glyph.ends[contour] ?? -1); i += 1) {
        points[i * 2] = (points[i * 2] ?? 0) + dx;
        points[i * 2 + 1] = (points[i * 2 + 1] ?? 0) + dy;
      }
    }
    let bitmap: GlyphBitmap = { left: 0, top: 0, width: 0, rows: 0, pixels: new Uint8Array(0) };
    if (points.length) {
      let xMin = Infinity;
      let yMin = Infinity;
      let xMax = -Infinity;
      let yMax = -Infinity;
      for (let i = 0; i < points.length; i += 2) {
        xMin = Math.min(xMin, points[i] ?? 0);
        xMax = Math.max(xMax, points[i] ?? 0);
        yMin = Math.min(yMin, points[i + 1] ?? 0);
        yMax = Math.max(yMax, points[i + 1] ?? 0);
      }
      // ft_glyphslot_preset_bitmap for FT_RENDER_MODE_NORMAL.
      const left = Math.floor(xMin / 64);
      const bottom = Math.floor(yMin / 64);
      const top = Math.ceil(yMax / 64);
      const width = Math.ceil(xMax / 64) - left;
      const rows = top - bottom;
      const shifted = points.map((value, i) => value - 64 * (i % 2 === 0 ? left : bottom));
      bitmap = { left, top, width, rows, pixels: rasterize(shifted, glyph.onCurve, glyph.ends, width, rows) };
    }
    bitmaps.set(key, bitmap);
    return bitmap;
  };

  const axis = (inSize: number, outSize: number) => {
    const key = `${inSize}:${outSize}`;
    let value = axes.get(key);
    if (!value) {
      value = coefficients(inSize, outSize);
      axes.set(key, value);
    }
    return value;
  };

  const unsupported = (text: string) => [...new Set([...text].filter((ch) => !glyphs.has(ch.codePointAt(0) ?? 0)))];

  const layer: GlyphSet['layer'] = (text, capHeight, x0, baseY, track, frameWidth, frameHeight) => {
    // int(round(cap_h / 0.70)) * S
    const px = roundHalfEven(capHeight / 0.7) * S;
    const index = sizeIndex.get(px);
    if (index === undefined) {
      throw new Error(`The glyph data has no ${px}px size.`);
    }
    const canvasWidth = frameWidth * S;
    const canvasHeight = frameHeight * S;

    // Place each character as ImageDraw.text((x, base_y * S), ch, anchor='ls') does: Pillow renders
    // the glyph at the origin and moves it by whole pixels, rounding the fractional start in float32.
    const placed: { bitmap: GlyphBitmap; left: number; top: number }[] = [];
    let x = x0 * S;
    const y = baseY * S;
    for (const ch of text) {
      const codepoint = ch.codePointAt(0) ?? 0;
      const glyph = glyphs.get(codepoint);
      if (!glyph) {
        throw new Error(`The glyph data has no ${ch}.`);
      }
      const bitmap = glyphBitmap(codepoint, glyph, index);
      if (bitmap.width && bitmap.rows) {
        const xMinPx = Math.min(0, bitmap.left);
        const start = Math.fround(Math.fround(-xMinPx) + Math.fround(x - Math.trunc(x)));
        const left = Math.trunc(x) + xMinPx + pixelRound(cRound(start * 64)) + bitmap.left;
        placed.push({ bitmap, left, top: Math.trunc(y) - bitmap.top });
      }
      x += (glyph.advances[index] ?? 0) / 64 + track * S;
    }
    const end = x / S;
    if (!placed.length) {
      return { alpha: emptyField(), end, clipped: false };
    }

    // The 4x canvas, only where glyphs landed (Pillow clips them to the image).
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    for (const { bitmap, left, top } of placed) {
      cx0 = Math.min(cx0, left);
      cy0 = Math.min(cy0, top);
      cx1 = Math.max(cx1, left + bitmap.width);
      cy1 = Math.max(cy1, top + bitmap.rows);
    }
    const clipped = cx0 < 0 || cy0 < 0 || cx1 > canvasWidth || cy1 > canvasHeight;
    cx0 = Math.max(cx0, 0);
    cy0 = Math.max(cy0, 0);
    cx1 = Math.min(cx1, canvasWidth);
    cy1 = Math.min(cy1, canvasHeight);
    if (cx1 <= cx0 || cy1 <= cy0) {
      return { alpha: emptyField(), end, clipped };
    }
    const cw = cx1 - cx0;
    const ch = cy1 - cy0;
    const canvas = new Uint8Array(cw * ch);
    for (const { bitmap, left, top } of placed) {
      for (let row = Math.max(0, cy0 - top); row < Math.min(bitmap.rows, cy1 - top); row += 1) {
        for (let column = Math.max(0, cx0 - left); column < Math.min(bitmap.width, cx1 - left); column += 1) {
          const at = (top + row - cy0) * cw + left + column - cx0;
          canvas[at] = blend255(canvas[at] ?? 0, bitmap.pixels[row * bitmap.width + column] ?? 0);
        }
      }
    }

    // Image.resize((W, H), Image.LANCZOS): horizontal pass to bytes, then vertical, for the outputs
    // whose taps reach the inked canvas (every other output is exactly 0).
    const horizontal = axis(canvasWidth, frameWidth);
    const vertical = axis(canvasHeight, frameHeight);
    const [ox0, ox1] = reach(horizontal, frameWidth, cx0, cx1);
    const [oy0, oy1] = reach(vertical, frameHeight, cy0, cy1);
    const ow = ox1 - ox0;
    const oh = oy1 - oy0;
    const rows = new Uint8Array(ch * ow);
    for (let row = 0; row < ch; row += 1) {
      for (let ox = ox0; ox < ox1; ox += 1) {
        const start = horizontal.bounds[ox * 2] ?? 0;
        const count = horizontal.bounds[ox * 2 + 1] ?? 0;
        let sum = 1 << (PRECISION_BITS - 1);
        for (let t = Math.max(0, cx0 - start); t < Math.min(count, cx1 - start); t += 1) {
          sum += (canvas[row * cw + start + t - cx0] ?? 0) * (horizontal.weights[ox * horizontal.ksize + t] ?? 0);
        }
        rows[row * ow + ox - ox0] = clip8(sum);
      }
    }
    const out = new Float32Array(ow * oh);
    for (let oy = oy0; oy < oy1; oy += 1) {
      const start = vertical.bounds[oy * 2] ?? 0;
      const count = vertical.bounds[oy * 2 + 1] ?? 0;
      for (let ox = 0; ox < ow; ox += 1) {
        let sum = 1 << (PRECISION_BITS - 1);
        for (let t = Math.max(0, cy0 - start); t < Math.min(count, cy1 - start); t += 1) {
          sum += (rows[(start + t - cy0) * ow + ox] ?? 0) * (vertical.weights[oy * vertical.ksize + t] ?? 0);
        }
        out[(oy - oy0) * ow + ox] = clip8(sum) / 255;
      }
    }
    return { alpha: { x: ox0, y: oy0, width: ow, height: oh, data: out }, end, clipped };
  };

  return { unsupported, layer };
};
