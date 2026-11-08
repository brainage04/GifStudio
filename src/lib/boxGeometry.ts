export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const resizeDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type ResizeDirection = (typeof resizeDirections)[number];

export interface SizeLimits {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface ResizeOptions {
  limits: SizeLimits;
  /** Keep the box inside a `width` x `height` space, as a crop must. */
  contain?: { width: number; height: number };
  /** Width/height ratio a corner handle keeps; edge handles ignore it. */
  aspect?: number | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The box after dragging the `direction` handle of `start` by `(dx, dy)`: the opposite edge or corner
 * stays put, sizes stay within `limits` (and within `contain` measured from that anchor).
 */
export const resizeBox = (
  start: Box,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  { limits, contain, aspect }: ResizeOptions,
): Box => {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let { maxWidth, maxHeight } = limits;
  if (contain) {
    if (direction.includes('e')) maxWidth = Math.min(maxWidth, contain.width - start.x);
    if (direction.includes('w')) maxWidth = Math.min(maxWidth, right);
    if (direction.includes('s')) maxHeight = Math.min(maxHeight, contain.height - start.y);
    if (direction.includes('n')) maxHeight = Math.min(maxHeight, bottom);
  }

  let width = start.width;
  let height = start.height;
  if (direction.includes('e')) width = start.width + dx;
  if (direction.includes('w')) width = start.width - dx;
  if (direction.includes('s')) height = start.height + dy;
  if (direction.includes('n')) height = start.height - dy;
  width = clamp(width, limits.minWidth, maxWidth);
  height = clamp(height, limits.minHeight, maxHeight);

  if (aspect && direction.length === 2) {
    // The edge that moved further leads; then shrink or grow both together back into the limits.
    if (Math.abs(width - start.width) >= Math.abs(height - start.height)) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
    const shrink = Math.min(1, maxWidth / width, maxHeight / height);
    width *= shrink;
    height *= shrink;
    const grow = Math.max(1, limits.minWidth / width, limits.minHeight / height);
    width *= grow;
    height *= grow;
  }

  return {
    x: direction.includes('w') ? right - width : start.x,
    y: direction.includes('n') ? bottom - height : start.y,
    width,
    height,
  };
};

/** `box` moved by `(dx, dy)` but kept inside a `width` x `height` space. */
export const moveBoxInside = (box: Box, dx: number, dy: number, space: { width: number; height: number }): Box => ({
  ...box,
  x: clamp(box.x + dx, 0, Math.max(0, space.width - box.width)),
  y: clamp(box.y + dy, 0, Math.max(0, space.height - box.height)),
});
