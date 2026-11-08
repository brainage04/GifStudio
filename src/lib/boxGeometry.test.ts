import { describe, expect, it } from 'vitest';
import { moveBoxInside, resizeBox } from './boxGeometry';

const limits = { minWidth: 10, minHeight: 10, maxWidth: 500, maxHeight: 500 };
const start = { x: 100, y: 100, width: 100, height: 50 };

describe('resizeBox', () => {
  it('keeps the opposite corner fixed when dragging the north-west handle', () => {
    expect(resizeBox(start, 'nw', -20, -10, { limits })).toEqual({ x: 80, y: 90, width: 120, height: 60 });
  });

  it('stops at the minimum size without moving the anchored edge', () => {
    expect(resizeBox(start, 'w', 200, 0, { limits })).toEqual({ x: 190, y: 100, width: 10, height: 50 });
  });

  it('keeps a contained box inside the space, measured from its anchor', () => {
    const space = { width: 250, height: 400 };
    expect(resizeBox(start, 'se', 300, 0, { limits, contain: space })).toEqual({
      x: 100,
      y: 100,
      width: 150,
      height: 50,
    });
    expect(resizeBox(start, 'n', 0, -300, { limits, contain: space })).toEqual({
      x: 100,
      y: 0,
      width: 100,
      height: 150,
    });
  });

  it('keeps the aspect ratio on corners, led by the edge that moved further, within the contained space', () => {
    const square = { x: 50, y: 50, width: 100, height: 100 };
    const space = { width: 300, height: 180 };
    // Width would reach 200, but only 130 fits below the anchor, so both stop at 130.
    expect(resizeBox(square, 'se', 100, 10, { limits, contain: space, aspect: 1 })).toEqual({
      x: 50,
      y: 50,
      width: 130,
      height: 130,
    });
  });

  it('ignores the aspect ratio on edge handles', () => {
    expect(resizeBox(start, 'e', 50, 0, { limits, aspect: 2 })).toEqual({ x: 100, y: 100, width: 150, height: 50 });
  });
});

describe('moveBoxInside', () => {
  it('stops at the space edges', () => {
    expect(moveBoxInside(start, -500, 500, { width: 300, height: 300 })).toEqual({
      x: 0,
      y: 250,
      width: 100,
      height: 50,
    });
  });
});
