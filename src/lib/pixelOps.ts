/**
 * The OpenCV calls the WhoIsThisKid compositor makes, reproduced with OpenCV's border handling and
 * rounding so the browser remake matches the original Python script.
 */

/**
 * A rectangle of single-channel values in frame pixels; the frame is 0 everywhere outside it. The
 * script's arrays are float32 unless NumPy promoted them to float64, and the data type says which.
 */
export interface Field {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Float32Array | Float64Array;
}

export const emptyField = (): Field => ({ x: 0, y: 0, width: 0, height: 0, data: new Float32Array(0) });

/** Python's `round()` and OpenCV's `cvRound`: halves go to the even neighbour. */
export const roundHalfEven = (value: number) => {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) {
    return fraction < 0.5 ? floor : floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
};

/** OpenCV `BORDER_REFLECT_101` (`gfedcb|abcdefgh|gfedcba`), the default border for filtering. */
const reflect101 = (index: number, length: number) => {
  if (length === 1) {
    return 0;
  }
  let p = index;
  while (p < 0 || p >= length) {
    p = p < 0 ? -p : 2 * length - 2 - p;
  }
  return p;
};

/** The Gaussian kernel radius OpenCV picks for `sigma` on a float image (4 sigma each side, odd size). */
export const gaussianRadius = (sigma: number) => ((roundHalfEven(sigma * 8 + 1) | 1) - 1) / 2;

/** `cv2.GaussianBlur(src, (0, 0), sigma)` on a single-channel float32 image. */
export const gaussianBlur = (src: Float32Array, width: number, height: number, sigma: number) => {
  const radius = gaussianRadius(sigma);
  const size = radius * 2 + 1;
  const kernel = new Float64Array(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    const weight = Math.exp((-0.5 * (i - radius) ** 2) / (sigma * sigma));
    kernel[i] = weight;
    total += weight;
  }
  for (let i = 0; i < size; i += 1) {
    kernel[i] = (kernel[i] ?? 0) / total;
  }

  const rows = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const line = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = 0; k < size; k += 1) {
        sum += (src[line + reflect101(x + k - radius, width)] ?? 0) * (kernel[k] ?? 0);
      }
      rows[line + x] = sum;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = 0; k < size; k += 1) {
        sum += (rows[reflect101(y + k - radius, height) * width + x] ?? 0) * (kernel[k] ?? 0);
      }
      out[y * width + x] = sum;
    }
  }
  return out;
};

/** `field` grown by `margin` on every side, clipped to the frame, with the new area 0. */
const grow = (field: Field, margin: number, frameWidth: number, frameHeight: number): Field => {
  const x = Math.max(field.x - margin, 0);
  const y = Math.max(field.y - margin, 0);
  const width = Math.min(field.x + field.width + margin, frameWidth) - x;
  const height = Math.min(field.y + field.height + margin, frameHeight) - y;
  const data = new Float32Array(Math.max(width, 0) * Math.max(height, 0));
  for (let row = 0; row < field.height; row += 1) {
    for (let column = 0; column < field.width; column += 1) {
      data[(field.y + row - y) * width + field.x + column - x] = field.data[row * field.width + column] ?? 0;
    }
  }
  return { x, y, width, height, data };
};

/** `cv2.dilate(src, np.ones((size, size)))` on a frame of values >= 0 that is 0 outside `field`. */
export const dilateField = (field: Field, size: number, frameWidth: number, frameHeight: number): Field => {
  const radius = (size - 1) / 2;
  const out = grow(field, radius, frameWidth, frameHeight);
  const { width, height } = out;
  // A rectangle's maximum is separable; outside the frame OpenCV's border never wins the maximum.
  const rows = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let k = Math.max(x - radius, 0); k <= Math.min(x + radius, width - 1); k += 1) {
        max = Math.max(max, out.data[y * width + k] ?? 0);
      }
      rows[y * width + x] = max;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let k = Math.max(y - radius, 0); k <= Math.min(y + radius, height - 1); k += 1) {
        max = Math.max(max, rows[k * width + x] ?? 0);
      }
      out.data[y * width + x] = max;
    }
  }
  return out;
};

/**
 * `cv2.GaussianBlur(src, (0, 0), sigma)` on a float32 frame that is 0 outside `field`. The blur runs
 * on the field grown by two kernel radii: wherever that crop stops short of the frame edge, its
 * mirrored border only ever reads zeros, so every value matches blurring the whole frame.
 */
export const blurField = (field: Field, sigma: number, frameWidth: number, frameHeight: number): Field => {
  const crop = grow(field, gaussianRadius(sigma) * 2, frameWidth, frameHeight);
  return { ...crop, data: gaussianBlur(Float32Array.from(crop.data), crop.width, crop.height, sigma) };
};

/** Source pixels and weights for each output index along one axis, flattened. */
type AxisTaps = { index: number[]; weight: number[]; offsets: number[] };

/**
 * OpenCV's `INTER_AREA` taps along one axis: `computeResizeAreaTab` when the image shrinks on both
 * axes, otherwise its linear taps with area-mode offsets (OpenCV switches on both axes together).
 */
const areaTaps = (sourceSize: number, outSize: number, shrinking: boolean): AxisTaps => {
  const scale = sourceSize / outSize;
  const taps: AxisTaps = { index: [], weight: [], offsets: [0] };
  const push = (source: number, weight: number) => {
    taps.index.push(source);
    taps.weight.push(weight);
  };

  for (let d = 0; d < outSize; d += 1) {
    if (shrinking) {
      const fs1 = d * scale;
      const fs2 = fs1 + scale;
      const s2 = Math.min(Math.floor(fs2), sourceSize - 1);
      const s1 = Math.min(Math.ceil(fs1), s2);
      const cell = Math.min(scale, sourceSize - fs1);
      if (s1 - fs1 > 1e-3) {
        push(s1 - 1, (s1 - fs1) / cell);
      }
      for (let s = s1; s < s2; s += 1) {
        push(s, 1 / cell);
      }
      if (fs2 - s2 > 1e-3) {
        push(s2, Math.min(fs2 - s2, 1, cell) / cell);
      }
    } else {
      let s = Math.floor(d * scale);
      let f = d + 1 - (s + 1) / scale;
      f = f <= 0 ? 0 : f - Math.floor(f);
      if (s >= sourceSize - 1) {
        s = sourceSize - 1;
        f = 0;
      }
      push(s, 1 - f);
      if (f) {
        push(s + 1, f);
      }
    }
    taps.offsets.push(taps.index.length);
  }
  return taps;
};

/**
 * `cv2.resize(src, (outWidth, outHeight), interpolation=cv2.INTER_AREA)` on interleaved `channels`.
 * A `Uint8Array` source gives rounded bytes and a `Float32Array` source floats, as OpenCV does. When
 * shrinking, OpenCV's `resizeArea_` keeps its weights and running sums in float32 for both, and so
 * does this: a fully opaque mask can come out a hair under 1, which the script's truncating blends see.
 */
export function resizeArea(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  outWidth: number,
  outHeight: number,
): Uint8Array<ArrayBuffer>;
export function resizeArea(
  src: Float32Array,
  width: number,
  height: number,
  channels: number,
  outWidth: number,
  outHeight: number,
): Float32Array<ArrayBuffer>;
export function resizeArea(
  src: Uint8Array | Float32Array,
  width: number,
  height: number,
  channels: number,
  outWidth: number,
  outHeight: number,
): Uint8Array<ArrayBuffer> | Float32Array<ArrayBuffer> {
  const shrinking = width >= outWidth && height >= outHeight;
  const xTaps = areaTaps(width, outWidth, shrinking);
  const yTaps = areaTaps(height, outHeight, shrinking);
  // float32 maths when shrinking (resizeArea_<T, float>); the linear enlarge path stays in double.
  const round = shrinking ? Math.fround : (value: number) => value;

  const rows = shrinking
    ? new Float32Array(height * outWidth * channels)
    : new Float64Array(height * outWidth * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      for (let t = xTaps.offsets[x] ?? 0; t < (xTaps.offsets[x + 1] ?? 0); t += 1) {
        const from = (y * width + (xTaps.index[t] ?? 0)) * channels;
        const to = (y * outWidth + x) * channels;
        const weight = round(xTaps.weight[t] ?? 0);
        for (let c = 0; c < channels; c += 1) {
          rows[to + c] = (rows[to + c] ?? 0) + round((src[from + c] ?? 0) * weight);
        }
      }
    }
  }

  const bytes = src instanceof Uint8Array;
  const size = outWidth * outHeight * channels;
  const out = bytes ? new Uint8Array(size) : new Float32Array(size);
  const sums = new Float64Array(channels);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      sums.fill(0);
      for (let t = yTaps.offsets[y] ?? 0; t < (yTaps.offsets[y + 1] ?? 0); t += 1) {
        const from = ((yTaps.index[t] ?? 0) * outWidth + x) * channels;
        const weight = round(yTaps.weight[t] ?? 0);
        for (let c = 0; c < channels; c += 1) {
          sums[c] = round((sums[c] ?? 0) + round((rows[from + c] ?? 0) * weight));
        }
      }
      for (let c = 0; c < channels; c += 1) {
        const sum = sums[c] ?? 0;
        out[(y * outWidth + x) * channels + c] = bytes ? Math.min(255, Math.max(0, roundHalfEven(sum))) : sum;
      }
    }
  }
  return out;
}
