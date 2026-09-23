export const MIN_OVERLAY_DIMENSION = 16;
export const MAX_OVERLAY_SCALE = 4;

/** Largest overlay edge the editor allows; unbounded until the overlay's natural size is known. */
export const maxOverlayDimension = (natural: number) =>
  natural > 0 ? Math.max(natural * MAX_OVERLAY_SCALE, MIN_OVERLAY_DIMENSION) : Infinity;

/** Clamp a typed overlay edge to the same upper bound the resize handles enforce. */
export const clampOverlayDimension = (value: number, natural: number) =>
  Math.min(Math.max(value || 1, 1), maxOverlayDimension(natural));
