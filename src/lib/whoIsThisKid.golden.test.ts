import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import glyphJson from '../../public/assets/who-is-this-kid/glyphs.json';
import templateJson from '../data/whoIsThisKidTemplate.json';
import goldenJson from './__fixtures__/who-is-this-kid/index.json';
import { createGlyphSet, type GlyphData, type GlyphSet } from './textLayer';
import {
  captionWord,
  centeredCrop,
  composeFrame,
  createCaptions,
  pictureSizeLimit,
  preparePicture,
  type Picture,
  type TemplatePixels,
  type WhoIsThisKidTemplate,
} from './whoIsThisKid';

/**
 * The browser compositor against tools/who-is-this-kid/who_is_this.py, the script it was ported
 * from, on a fixed picture (fixtures written by tools/who-is-this-kid/make_golden.py).
 */

const template = templateJson as WhoIsThisKidTemplate;
const path = (relative: string) => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const fixtures = (file: string) => path(`./__fixtures__/who-is-this-kid/${file}`);
const asset = (file: string) => path(`../../public/assets/who-is-this-kid/${file}`);

interface Golden {
  picture: string;
  captionFrames: number[];
  words: {
    word: string;
    file: string;
    frames: ({ x: number; y: number; width: number; height: number; sheetY: number } | null)[];
  }[];
}
const golden = goldenJson as Golden;
const { width, height } = template;
const frameBytes = width * height * 3;
const frameCount = template.frames.length;
// Thresholds per compared frame. Text rendering matches the script byte for byte; what is left is
// OpenCV's float32 SIMD Gaussian filtering against this port's double-precision sums, which flips a
// few `astype(np.uint8)` truncations by one (measured: at most 1, on at most 0.03% of values, about
// 83 dB). Leaving the captions out entirely differs by up to 213 on ~3% of values; a caption or the
// picture a pixel out of place, or another size, weight or colour, breaks the first bound at once.
const MAX_DIFFERENCE = 1;
const MAX_DIFFERING_SHARE = 0.001;
const MIN_PSNR = 70;

let pixels: TemplatePixels;
let glyphs: GlyphSet;
let picture: Picture;
const expectedFrames: Uint8Array[] = [];

const rgbPixels = async (file: string, options?: Parameters<typeof sharp>[1]) =>
  new Uint8Array(await sharp(file, options).removeAlpha().raw().toBuffer());

/** `base` with each frame's stored crop applied where the crop's alpha is set. */
const applyGolden = async (base: Uint8Array, entry: Golden['words'][number]) => {
  const { data, info } = await sharp(fixtures(entry.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = base.slice();
  entry.frames.forEach((box, frame) => {
    if (!box) return;
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const s = ((box.sheetY + y) * info.width + x) * 4;
        if (data[s + 3] === 0) continue;
        const d = frame * frameBytes + ((box.y + y) * width + box.x + x) * 3;
        out[d] = data[s] ?? 0;
        out[d + 1] = data[s + 1] ?? 0;
        out[d + 2] = data[s + 2] ?? 0;
      }
    }
  });
  return out;
};

const compare = (actual: Uint8Array, expected: Uint8Array) => {
  let differing = 0;
  let maxDifference = 0;
  let squared = 0;
  for (let i = 0; i < actual.length; i += 1) {
    const difference = Math.abs((actual[i] ?? 0) - (expected[i] ?? 0));
    if (difference) {
      differing += 1;
      maxDifference = Math.max(maxDifference, difference);
      squared += difference * difference;
    }
  }
  const mse = squared / actual.length;
  return {
    differingShare: differing / actual.length,
    maxDifference,
    psnr: mse ? 10 * Math.log10((255 * 255) / mse) : Infinity,
  };
};

beforeAll(async () => {
  pixels = {
    frames: await rgbPixels(asset(template.source), { pages: -1 }),
    patches: await rgbPixels(asset(template.patches.file)),
  };
  glyphs = createGlyphSet(glyphJson as unknown as GlyphData);
  const { data, info } = await sharp(fixtures(golden.picture))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // The script's defaults: centred square crop, size 1.6, shape auto.
  picture = preparePicture(new Uint8Array(data), info.width, info.height, {
    crop: centeredCrop(info.width, info.height),
    shape: 'auto',
    maxSize: pictureSizeLimit(template, 1.6),
  });
  let base = pixels.frames;
  for (const [index, entry] of golden.words.entries()) {
    const frames = await applyGolden(base, entry);
    expectedFrames.push(frames);
    if (index === 0) base = frames;
  }
}, 60_000);

describe('WhoIsThisKid compositor against who_is_this.py', () => {
  golden.words.forEach((entry, index) => {
    const compared = index === 0 ? [...Array(frameCount).keys()] : golden.captionFrames;
    it(`matches the script for "${entry.word}" (${compared.length} frames)`, () => {
      const captions = createCaptions(template, glyphs, captionWord(entry.word));
      expect(captions.problem).toBeNull();
      const placement = { scale: 1.6, offsetX: 0, offsetY: 0 };
      for (const frame of compared) {
        const actual = composeFrame(template, pixels, frame, picture, { placement, captions });
        const expected =
          expectedFrames[index]?.subarray(frame * frameBytes, (frame + 1) * frameBytes) ?? new Uint8Array();
        const result = compare(actual, expected);
        expect.soft(result.maxDifference, `frame ${frame}: largest difference`).toBeLessThanOrEqual(MAX_DIFFERENCE);
        expect
          .soft(result.differingShare, `frame ${frame}: share of values that differ`)
          .toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
        expect.soft(result.psnr, `frame ${frame}: PSNR`).toBeGreaterThanOrEqual(MIN_PSNR);
      }
    });
  });

  it('refuses words the script would draw off the frame or cannot draw', () => {
    const problem = (typed: string) => createCaptions(template, glyphs, captionWord(typed)).problem;
    expect(problem('legend')).toEqual({ kind: 'too-wide' });
    expect(problem('  ')).toEqual({ kind: 'empty' });
    expect(problem('a$b😀')).toEqual({ kind: 'unsupported', characters: ['$', '😀'] });
    // A decomposed accent is composed first, so it draws as the script draws "É".
    expect(problem('e\u0301')).toBeNull();
  });
});
