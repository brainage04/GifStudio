import { describe, expect, it } from 'vitest';
import { gaussianBlur, resizeArea, roundHalfEven } from './pixelOps';

// Expected values come from OpenCV 4.13 (cv2.GaussianBlur / cv2.resize with INTER_AREA) on the same inputs.

describe('roundHalfEven', () => {
  it('rounds halves to the even neighbour like Python and cvRound', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2, 2, 3]);
  });
});

describe('gaussianBlur', () => {
  it('matches cv2.GaussianBlur(src, (0, 0), 0.7), reflecting at every edge', () => {
    const src = new Float32Array(6 * 7);
    src[0] = 1;
    src[2 * 7 + 3] = 0.5;
    src[5 * 7 + 6] = 0.25;
    const expected = [
      0.324725, 0.117139, 0.007457, 0.005515, 0.001976, 9.3e-5, 1e-6, 0.117058, 0.043177, 0.023076, 0.058552, 0.021101,
      0.000988, 1.2e-5, 0.005515, 0.004716, 0.058616, 0.162363, 0.058523, 0.002744, 4.2e-5, 4.5e-5, 0.001, 0.021095,
      0.058523, 0.021118, 0.001482, 0.001382, 1e-6, 4.6e-5, 0.000988, 0.002744, 0.001482, 0.010594, 0.029262, 0, 1e-6,
      1.2e-5, 4.2e-5, 0.001382, 0.029262, 0.081181,
    ];

    const blurred = Array.from(gaussianBlur(src, 7, 6, 0.7));

    blurred.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 5));
  });
});

describe('resizeArea', () => {
  const image = Uint8Array.from({ length: 5 * 7 * 3 }, (_, i) => (i * 7) % 256);

  it('matches cv2.resize INTER_AREA when shrinking by a non-integer factor', () => {
    expect(Array.from(resizeArea(image, 7, 5, 3, 3, 2))).toEqual([
      81, 88, 95, 129, 136, 143, 134, 97, 104, 127, 134, 141, 146, 153, 116, 121, 128, 135,
    ]);
  });

  it('matches cv2.resize INTER_AREA when growing, which OpenCV does with linear taps', () => {
    const ramp = Float32Array.from({ length: 25 }, (_, i) => i / 24);
    const expected = [
      0, 0.025, 0.05, 0.083333, 0.116667, 0.141667, 0.166667, 0.125, 0.15, 0.175, 0.208333, 0.241667, 0.266667,
      0.291667, 0.25, 0.275, 0.3, 0.333333, 0.366667, 0.391667, 0.416667, 0.416667, 0.441667, 0.466667, 0.5, 0.533333,
      0.558333, 0.583333, 0.583333, 0.608333, 0.633333, 0.666667, 0.7, 0.725, 0.75, 0.708333, 0.733333, 0.758333,
      0.791667, 0.825, 0.85, 0.875, 0.833333, 0.858333, 0.883333, 0.916667, 0.95, 0.975, 1,
    ];

    const grown = Array.from(resizeArea(ramp, 5, 5, 1, 7, 7));

    grown.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 5));
  });
});
