import { resizeBox, resizeDirections, type Box, type ResizeDirection, type ResizeOptions } from '../lib/boxGeometry';

export interface BoxEditorOptions {
  /** Positioned element the box sits in; its rendered width spans `space().width` units. */
  stage: HTMLElement;
  /** The absolutely positioned box; dragging it moves, its added handles resize. */
  element: HTMLElement;
  space: () => { width: number; height: number };
  /** The box as it is now, in `space` units. */
  current: () => Box;
  /** Resize rules for a handle drag that started from `start`. */
  resizeOptions: (start: Box, shiftKey: boolean) => ResizeOptions;
  /** Where a drag of `(dx, dy)` from `start` puts the box. */
  move: (start: Box, dx: number, dy: number) => Box;
  /** Every new box while a pointer is down, then once more with `done` when it is released. */
  onChange: (box: Box, done: boolean) => void;
  /** Ignore pointers while this is false (e.g. nothing loaded yet). */
  enabled?: () => boolean;
}

type ActivePointer = {
  pointerId: number;
  target: HTMLElement;
  direction: ResizeDirection | null;
  startClientX: number;
  startClientY: number;
  start: Box;
  scale: number;
};

const isResizeDirection = (value: string | undefined): value is ResizeDirection =>
  resizeDirections.some((direction) => direction === value);

/** Drag-to-move and eight-handle resize for a box over a stage, in the stage's own units. */
export const createBoxEditor = (options: BoxEditorOptions) => {
  const { stage, element } = options;
  for (const direction of resizeDirections) {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-handle-${direction}`;
    handle.dataset.direction = direction;
    handle.setAttribute('aria-hidden', 'true');
    element.append(handle);
  }

  const stageScale = () => stage.getBoundingClientRect().width / (options.space().width || 1);
  let active: ActivePointer | null = null;

  element.addEventListener('pointerdown', (event) => {
    const scale = stageScale();
    if ((options.enabled && !options.enabled()) || !(event.target instanceof HTMLElement) || !scale) {
      return;
    }
    const direction = event.target.dataset.direction;
    event.preventDefault();
    event.stopPropagation();
    active = {
      pointerId: event.pointerId,
      target: event.target,
      direction: isResizeDirection(direction) ? direction : null,
      startClientX: event.clientX,
      startClientY: event.clientY,
      start: options.current(),
      scale,
    };
    event.target.setPointerCapture(event.pointerId);
  });

  window.addEventListener('pointermove', (event) => {
    if (!active || event.pointerId !== active.pointerId) {
      return;
    }
    const dx = (event.clientX - active.startClientX) / active.scale;
    const dy = (event.clientY - active.startClientY) / active.scale;
    options.onChange(
      active.direction
        ? resizeBox(active.start, active.direction, dx, dy, options.resizeOptions(active.start, event.shiftKey))
        : options.move(active.start, dx, dy),
      false,
    );
  });

  const end = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) {
      return;
    }
    if (active.target.hasPointerCapture(event.pointerId)) {
      active.target.releasePointerCapture(event.pointerId);
    }
    active = null;
    options.onChange(options.current(), true);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  return {
    /** Position the box element for `box` at the stage's current rendered size. */
    layout: (box: Box) => {
      const scale = stageScale();
      element.style.left = `${box.x * scale}px`;
      element.style.top = `${box.y * scale}px`;
      element.style.width = `${box.width * scale}px`;
      element.style.height = `${box.height * scale}px`;
    },
  };
};

/**
 * Show only the `crop` part of `image` filling its box: the image is scaled and shifted inside an
 * `overflow: hidden` parent. `natural` is the image's full size.
 */
export const showCrop = (image: HTMLElement, crop: Box, natural: { width: number; height: number }) => {
  image.style.width = `${(natural.width / crop.width) * 100}%`;
  image.style.height = `${(natural.height / crop.height) * 100}%`;
  image.style.left = `${(-crop.x / crop.width) * 100}%`;
  image.style.top = `${(-crop.y / crop.height) * 100}%`;
};
