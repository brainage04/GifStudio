import { describe, expect, it } from 'vitest';
import { clampOverlayDimension, MIN_OVERLAY_DIMENSION } from './placement';

describe('clampOverlayDimension', () => {
  it('caps a typed size at four times the overlay natural size', () => {
    expect(clampOverlayDimension(5000, 400)).toBe(1600);
    expect(clampOverlayDimension(1600, 400)).toBe(1600);
    expect(clampOverlayDimension(300, 400)).toBe(300);
  });

  it('keeps tiny overlays resizable up to the handle minimum', () => {
    expect(clampOverlayDimension(100, 2)).toBe(MIN_OVERLAY_DIMENSION);
  });

  it('falls back to 1 for empty or non-positive input and leaves unknown overlays unbounded', () => {
    expect(clampOverlayDimension(Number.NaN, 400)).toBe(1);
    expect(clampOverlayDimension(-20, 400)).toBe(1);
    expect(clampOverlayDimension(5000, 0)).toBe(5000);
  });
});
