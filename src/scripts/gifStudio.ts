import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { GifRenderer } from '../lib/GifRenderer';

const appBase = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/`;

const requireElement = <ElementType extends HTMLElement>(
  id: string,
  constructor: new (...args: never[]) => ElementType,
) => {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing #${id}`);
  }
  return element;
};

const baseDropzone = requireElement('base-dropzone', HTMLDivElement);
const baseFileInput = requireElement('base-file-input', HTMLInputElement);
const baseUrlInput = requireElement('base-url-input', HTMLInputElement);
const baseUrlLoadButton = requireElement('base-url-load-button', HTMLButtonElement);
const baseSelectedFile = requireElement('base-selected-file', HTMLParagraphElement);
const basePreviewImage = requireElement('base-preview-image', HTMLImageElement);
const dropzone = requireElement('dropzone', HTMLDivElement);
const fileInput = requireElement('file-input', HTMLInputElement);
const overlayUrlInput = requireElement('overlay-url-input', HTMLInputElement);
const overlayUrlLoadButton = requireElement('overlay-url-load-button', HTMLButtonElement);
const selectedFile = requireElement('selected-file', HTMLParagraphElement);
const overlayPreview = requireElement('overlay-preview', HTMLDivElement);
const overlayPreviewImage = requireElement('overlay-preview-image', HTMLImageElement);
const placementStage = requireElement('placement-stage', HTMLDivElement);
const stageBase = requireElement('stage-base', HTMLImageElement);
const stageOverlay = requireElement('stage-overlay', HTMLDivElement);
const overlayImage = requireElement('overlay-image', HTMLImageElement);
const handlesToggle = requireElement('handles-toggle', HTMLInputElement);
const statusText = requireElement('status', HTMLParagraphElement);
const downloadLink = requireElement('download-link', HTMLAnchorElement);
const xInput = requireElement('x-input', HTMLInputElement);
const yInput = requireElement('y-input', HTMLInputElement);
const widthInput = requireElement('width-input', HTMLInputElement);
const heightInput = requireElement('height-input', HTMLInputElement);

const MIN_OVERLAY_DIMENSION = 16;
const MAX_OVERLAY_SCALE = 4;
const resizeDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type ResizeDirection = (typeof resizeDirections)[number];

type Placement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ActivePointer =
  | {
      mode: 'drag';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      stageScale: number;
    }
  | {
      mode: 'resize';
      direction: ResizeDirection;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
      stageScale: number;
    };

const resizeHandles: Partial<Record<ResizeDirection, HTMLDivElement>> = {};
const isResizeDirection = (value: string | undefined): value is ResizeDirection => {
  return resizeDirections.some((direction) => direction === value);
};

for (const direction of resizeDirections) {
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${direction}`;
  handle.id = `resize-handle-${direction}`;
  handle.dataset.direction = direction;
  handle.setAttribute('aria-hidden', 'true');
  resizeHandles[direction] = handle;
  stageOverlay.append(handle);
}

let overlayFile: File | null = null;
let overlayPreviewUrl: string | null = null;
let baseGifFile: File | null = null;
let basePreviewUrl: string | null = null;
let resultUrl: string | null = null;
let overlayNaturalWidth = 0;
let overlayNaturalHeight = 0;
let activePointer: ActivePointer | null = null;
let autoRenderTimer: number | null = null;
let renderController: AbortController | null = null;
let renderSequence = 0;
let baseFetchController: AbortController | null = null;
let overlayFetchController: AbortController | null = null;
const gifRenderer = new GifRenderer(new FFmpeg(), { coreURL: coreUrl, wasmURL: wasmUrl });

const setStatus = (message: string) => {
  statusText.textContent = message;
  statusText.hidden = !message;
};

const syncResizeHandles = () => {
  stageOverlay.dataset.resizeHandles = handlesToggle.checked ? 'visible' : 'hidden';
};

const loadingManagedImages = [basePreviewImage, overlayPreviewImage, stageBase, overlayImage] as const;

const elementOffsetTop = (element: HTMLElement) => {
  let top = 0;
  let current: HTMLElement | null = element;

  while (current) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  return top;
};

const syncImageLoading = () => {
  for (const image of loadingManagedImages) {
    image.loading = elementOffsetTop(image) <= window.innerHeight ? 'eager' : 'lazy';
  }
};

const queueImageLoadingSync = () => {
  window.requestAnimationFrame(syncImageLoading);
};

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

const isAbortError = (error: unknown) => {
  return error instanceof Error && error.name === 'AbortError';
};

const revokeUrls = () => {
  if (basePreviewUrl) {
    URL.revokeObjectURL(basePreviewUrl);
    basePreviewUrl = null;
  }
  if (overlayPreviewUrl) {
    URL.revokeObjectURL(overlayPreviewUrl);
    overlayPreviewUrl = null;
  }
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
};

const placementValues = (): Placement => ({
  x: Number(xInput.value) || 0,
  y: Number(yInput.value) || 0,
  width: Math.max(Number(widthInput.value) || 1, 1),
  height: Math.max(Number(heightInput.value) || 1, 1),
});

const baseSize = () => ({
  width: stageBase.naturalWidth || 400,
  height: stageBase.naturalHeight || 218,
});

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const maxOverlayWidth = () => Math.max(overlayNaturalWidth * MAX_OVERLAY_SCALE, MIN_OVERLAY_DIMENSION);
const maxOverlayHeight = () => Math.max(overlayNaturalHeight * MAX_OVERLAY_SCALE, MIN_OVERLAY_DIMENSION);

const normalizePlacement = ({ x, y, width, height }: Placement): Placement => {
  const size = baseSize();
  const safeWidth = Math.max(width || 1, 1);
  const safeHeight = Math.max(height || 1, 1);
  const minVisibleX = Math.min(safeWidth, Math.max(20, size.width * 0.05));
  const minVisibleY = Math.min(safeHeight, Math.max(20, size.height * 0.05));

  return {
    x: clamp(x || 0, minVisibleX - safeWidth, size.width - minVisibleX),
    y: clamp(y || 0, minVisibleY - safeHeight, size.height - minVisibleY),
    width: safeWidth,
    height: safeHeight,
  };
};

const syncPlacementPreview = () => {
  if (!overlayFile || !overlayNaturalWidth || !overlayNaturalHeight) {
    stageOverlay.hidden = true;
    return;
  }

  const stageRect = placementStage.getBoundingClientRect();
  if (!stageRect.width) {
    return;
  }

  const size = baseSize();
  const placement = normalizePlacement(placementValues());
  const scale = stageRect.width / size.width;

  stageOverlay.hidden = false;
  stageOverlay.style.left = `${placement.x * scale}px`;
  stageOverlay.style.top = `${placement.y * scale}px`;
  stageOverlay.style.width = `${placement.width * scale}px`;
  stageOverlay.style.height = `${placement.height * scale}px`;
  placementStage.style.aspectRatio = `${size.width} / ${size.height}`;
};

const setOverlayFile = (file: File | null) => {
  overlayFile = file;

  if (!overlayFile) {
    selectedFile.textContent = 'No file selected.';
    overlayPreview.hidden = true;
    stageOverlay.hidden = true;
    setStatus('');
    return;
  }

  if (overlayPreviewUrl) {
    URL.revokeObjectURL(overlayPreviewUrl);
  }

  overlayPreviewUrl = URL.createObjectURL(overlayFile);
  overlayPreviewImage.src = overlayPreviewUrl;
  overlayImage.src = overlayPreviewUrl;
  overlayPreview.hidden = false;
  selectedFile.textContent = `${overlayFile.name} • ${Math.round(overlayFile.size / 1024)} KB`;
  setStatus('');
  queueImageLoadingSync();
};

const setBasePreviewSource = (src: string) => {
  basePreviewImage.src = src;
  stageBase.src = src;
  queueImageLoadingSync();
};

const setBaseGifFile = (file: File | null) => {
  baseGifFile = file;

  if (!baseGifFile) {
    if (basePreviewUrl) {
      URL.revokeObjectURL(basePreviewUrl);
      basePreviewUrl = null;
    }
    setBasePreviewSource(`${appBase}assets/base/woman_is_talking.gif`);
    baseSelectedFile.textContent = 'Using default base GIF.';
    if (overlayFile) {
      scheduleRender(0);
    }
    return;
  }

  if (basePreviewUrl) {
    URL.revokeObjectURL(basePreviewUrl);
  }

  basePreviewUrl = URL.createObjectURL(baseGifFile);
  setBasePreviewSource(basePreviewUrl);
  baseSelectedFile.textContent = `${baseGifFile.name} • ${Math.round(baseGifFile.size / 1024)} KB`;
};

const showResult = (blob: Blob) => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
  }

  resultUrl = URL.createObjectURL(blob);
  downloadLink.href = resultUrl;
  downloadLink.download = 'woman_is_talking_overlay.gif';
  downloadLink.classList.remove('disabled');
  downloadLink.removeAttribute('aria-disabled');
};

const resetResult = () => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }

  downloadLink.removeAttribute('href');
  downloadLink.classList.add('disabled');
  downloadLink.setAttribute('aria-disabled', 'true');
};

const cancelScheduledRender = () => {
  if (autoRenderTimer) {
    window.clearTimeout(autoRenderTimer);
    autoRenderTimer = null;
  }
};

const renderGif = async () => {
  if (!overlayFile) {
    return;
  }
  const activeOverlayFile = overlayFile;

  cancelScheduledRender();
  renderController?.abort();
  const controller = new AbortController();
  renderController = controller;
  const requestId = ++renderSequence;
  resetResult();
  setStatus('Loading browser renderer...');

  try {
    await gifRenderer.prepare();
    if (controller.signal.aborted) return;

    setStatus('Rendering GIF in this browser...');
    let input = baseGifFile;
    if (!input) {
      const response = await fetch(`${appBase}assets/base/woman_is_talking.gif`);
      if (!response.ok) throw new Error('Default base GIF could not be loaded.');
      input = new File([await response.blob()], 'woman_is_talking.gif', { type: 'image/gif' });
    }

    const data = await gifRenderer.render({
      id: requestId,
      baseGif: await fetchFile(input),
      overlayImage: await fetchFile(activeOverlayFile),
      filterGraph: `[1:v]scale=${widthInput.value}:${heightInput.value}[overlay];[0:v][overlay]overlay=${xInput.value}:${yInput.value},split[gif][palette_src];[palette_src]palettegen[palette];[gif][palette]paletteuse`,
    });
    if (requestId !== renderSequence || controller.signal.aborted) return;
    const gifBytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data);
    showResult(new Blob([gifBytes], { type: 'image/gif' }));
    setStatus('');
  } catch (error) {
    if (!isAbortError(error)) {
      setStatus(errorMessage(error, 'Render failed in this browser.'));
    }
  } finally {
    if (renderController === controller) {
      renderController = null;
    }
  }
};

function scheduleRender(delay = 250) {
  if (!overlayFile) {
    return;
  }
  cancelScheduledRender();
  autoRenderTimer = window.setTimeout(() => {
    autoRenderTimer = null;
    renderGif();
  }, delay);
}

const handleBaseFiles = (files: FileList | null) => {
  const file = files?.[0];
  if (!file) {
    return;
  }

  const looksLikeGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
  if (!looksLikeGif) {
    setStatus('That base file is not a GIF.');
    return;
  }

  resetResult();
  setBaseGifFile(file);
  setStatus('');
};

const filenameFromUrl = (value: string, fallback: string) => {
  try {
    const name = new URL(value).pathname.split('/').pop();
    return name || fallback;
  } catch {
    return fallback;
  }
};

const fetchRemoteFile = async (value: string, accept: string, fallback: string, signal: AbortSignal) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https image URLs are supported.');
  }
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: accept }, signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      'The remote host did not allow this browser to fetch the image (CORS) or the network request failed.',
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`Remote image fetch failed: ${response.status} ${response.statusText}`.trim());
  }
  return new File([await response.blob()], filenameFromUrl(url.href, fallback), {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  });
};

const loadBaseGifFromUrl = async () => {
  const url = baseUrlInput.value.trim();
  if (!url) {
    setStatus('Enter a GIF URL first.');
    return;
  }

  baseFetchController?.abort();
  baseFetchController = new AbortController();
  baseUrlLoadButton.disabled = true;
  setStatus('Loading base GIF...');

  try {
    const file = await fetchRemoteFile(
      url,
      'image/gif,image/*;q=0.8,*/*;q=0.1',
      'base.gif',
      baseFetchController.signal,
    );
    if (file.type !== 'image/gif' && !file.name.toLowerCase().endsWith('.gif')) {
      throw new Error('URL did not return a GIF.');
    }
    resetResult();
    setBaseGifFile(file);
    setStatus('');
  } catch (error) {
    if (!isAbortError(error)) setStatus(errorMessage(error, 'Base GIF fetch failed.'));
  } finally {
    baseFetchController = null;
    baseUrlLoadButton.disabled = false;
  }
};

const handleFiles = (files: File[] | FileList | null) => {
  const file = files?.[0];
  if (!file) {
    return;
  }

  const knownImageName = /\.(gif|jpe?g|png|webp)$/i.test(file.name);
  if (!file.type.startsWith('image/') && !knownImageName) {
    setStatus('That file is not an image.');
    return;
  }

  resetResult();
  setOverlayFile(file);
};

const setOverlayBlob = (blob: Blob, filename: string) => {
  const file = new File([blob], filename || 'overlay-image', {
    type: blob.type || 'image/png',
  });
  handleFiles([file]);
};

const loadOverlayImageFromUrl = async () => {
  const url = overlayUrlInput.value.trim();
  if (!url) {
    setStatus('Enter an image URL first.');
    return;
  }

  overlayFetchController?.abort();
  overlayFetchController = new AbortController();
  overlayUrlLoadButton.disabled = true;
  setStatus('Loading overlay image...');

  try {
    const file = await fetchRemoteFile(url, 'image/*,*/*;q=0.1', 'overlay-image', overlayFetchController.signal);
    if (!file.type.startsWith('image/') && !/\.(gif|jpe?g|png|webp)$/i.test(file.name)) {
      throw new Error('URL did not return a supported image.');
    }
    setOverlayFile(file);
    setStatus('');
  } catch (error) {
    if (!isAbortError(error)) setStatus(errorMessage(error, 'Overlay image fetch failed.'));
  } finally {
    overlayFetchController = null;
    overlayUrlLoadButton.disabled = false;
  }
};

const loadDefaultOverlayImage = async () => {
  try {
    const response = await fetch(`${appBase}assets/overlays/brainage.jpg`);
    if (!response.ok) throw new Error('Default overlay image could not be loaded.');
    setOverlayBlob(await response.blob(), 'brainage.jpg');
    selectedFile.textContent = 'Using default overlay image.';
  } catch (error) {
    setStatus(errorMessage(error, 'Default overlay image could not be loaded.'));
  }
};

const updatePlacementInputs = (placement: Placement, options: { schedule?: boolean } = {}) => {
  const shouldSchedule = options.schedule ?? true;
  const normalized = normalizePlacement(placement);
  xInput.value = String(Math.round(normalized.x));
  yInput.value = String(Math.round(normalized.y));
  widthInput.value = String(Math.round(normalized.width));
  heightInput.value = String(Math.round(normalized.height));
  syncPlacementPreview();
  if (shouldSchedule) {
    scheduleRender();
  }
};

const beginDrag = (event: PointerEvent) => {
  const target = event.target;
  if (!overlayFile || (target instanceof HTMLElement && target.classList.contains('resize-handle'))) {
    return;
  }

  const stageRect = placementStage.getBoundingClientRect();
  const size = baseSize();
  const placement = placementValues();
  activePointer = {
    mode: 'drag',
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: placement.x,
    startY: placement.y,
    stageScale: stageRect.width / size.width,
  };
  stageOverlay.setPointerCapture(event.pointerId);
};

const beginResize = (event: PointerEvent) => {
  if (!overlayFile || !overlayNaturalWidth || !overlayNaturalHeight) {
    return;
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const direction = target.dataset.direction;
  if (!isResizeDirection(direction)) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
  const stageRect = placementStage.getBoundingClientRect();
  const size = baseSize();
  const placement = placementValues();
  activePointer = {
    mode: 'resize',
    direction,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: placement.x,
    startY: placement.y,
    startWidth: placement.width,
    startHeight: placement.height,
    stageScale: stageRect.width / size.width,
  };
  target.setPointerCapture(event.pointerId);
};

const handlePointerMove = (event: PointerEvent) => {
  if (!activePointer || event.pointerId !== activePointer.pointerId) {
    return;
  }

  if (activePointer.mode === 'drag') {
    const deltaX = (event.clientX - activePointer.startClientX) / activePointer.stageScale;
    const deltaY = (event.clientY - activePointer.startClientY) / activePointer.stageScale;
    const current = placementValues();
    updatePlacementInputs(
      {
        x: activePointer.startX + deltaX,
        y: activePointer.startY + deltaY,
        width: current.width,
        height: current.height,
      },
      { schedule: false },
    );
    return;
  }

  const deltaX = (event.clientX - activePointer.startClientX) / activePointer.stageScale;
  const deltaY = (event.clientY - activePointer.startClientY) / activePointer.stageScale;
  const direction = activePointer.direction;
  let x = activePointer.startX;
  let y = activePointer.startY;
  let width = activePointer.startWidth;
  let height = activePointer.startHeight;

  if (direction.includes('e')) {
    width = clamp(activePointer.startWidth + deltaX, MIN_OVERLAY_DIMENSION, maxOverlayWidth());
  }

  if (direction.includes('s')) {
    height = clamp(activePointer.startHeight + deltaY, MIN_OVERLAY_DIMENSION, maxOverlayHeight());
  }

  if (direction.includes('w')) {
    width = clamp(activePointer.startWidth - deltaX, MIN_OVERLAY_DIMENSION, maxOverlayWidth());
    x = activePointer.startX + (activePointer.startWidth - width);
  }

  if (direction.includes('n')) {
    height = clamp(activePointer.startHeight - deltaY, MIN_OVERLAY_DIMENSION, maxOverlayHeight());
    y = activePointer.startY + (activePointer.startHeight - height);
  }

  if (event.shiftKey && direction.length === 2 && overlayNaturalWidth && overlayNaturalHeight) {
    const aspectRatio = overlayNaturalWidth / overlayNaturalHeight;
    const anchorX = direction.includes('w') ? activePointer.startX + activePointer.startWidth : activePointer.startX;
    const anchorY = direction.includes('n') ? activePointer.startY + activePointer.startHeight : activePointer.startY;
    const widthChange = Math.abs(width - activePointer.startWidth);
    const heightChange = Math.abs(height - activePointer.startHeight);

    if (widthChange >= heightChange) {
      width = clamp(width, MIN_OVERLAY_DIMENSION, maxOverlayWidth());
      height = clamp(width / aspectRatio, MIN_OVERLAY_DIMENSION, maxOverlayHeight());
      width = clamp(height * aspectRatio, MIN_OVERLAY_DIMENSION, maxOverlayWidth());
    } else {
      height = clamp(height, MIN_OVERLAY_DIMENSION, maxOverlayHeight());
      width = clamp(height * aspectRatio, MIN_OVERLAY_DIMENSION, maxOverlayWidth());
      height = clamp(width / aspectRatio, MIN_OVERLAY_DIMENSION, maxOverlayHeight());
    }

    x = direction.includes('w') ? anchorX - width : anchorX;
    y = direction.includes('n') ? anchorY - height : anchorY;
  }

  updatePlacementInputs({ x, y, width, height }, { schedule: false });
};

const endPointerInteraction = (event: PointerEvent) => {
  if (!activePointer || event.pointerId !== activePointer.pointerId) {
    return;
  }

  if (activePointer.mode === 'drag') {
    stageOverlay.releasePointerCapture(event.pointerId);
  } else {
    const handle = resizeHandles[activePointer.direction];
    if (handle?.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }
  activePointer = null;
  scheduleRender(0);
};

baseFileInput.addEventListener('change', () => handleBaseFiles(baseFileInput.files));

for (const eventName of ['dragenter', 'dragover']) {
  baseDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    baseDropzone.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  baseDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    baseDropzone.classList.remove('is-dragging');
  });
}

baseDropzone.addEventListener('drop', (event) => handleBaseFiles(event.dataTransfer?.files ?? null));
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}

dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer?.files ?? null));
overlayUrlLoadButton.addEventListener('click', loadOverlayImageFromUrl);
overlayUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadOverlayImageFromUrl();
  }
});

stageBase.addEventListener('load', () => {
  syncPlacementPreview();
  if (overlayFile) {
    scheduleRender(0);
  }
  queueImageLoadingSync();
});

overlayImage.addEventListener('load', () => {
  overlayNaturalWidth = overlayImage.naturalWidth;
  overlayNaturalHeight = overlayImage.naturalHeight;
  widthInput.value = String(Math.round(overlayNaturalWidth / 2));
  heightInput.value = String(Math.round(overlayNaturalHeight / 2));
  syncPlacementPreview();
  scheduleRender(0);
  queueImageLoadingSync();
});

for (const input of [xInput, yInput, widthInput, heightInput]) {
  input.addEventListener('input', () => updatePlacementInputs(placementValues()));
}

stageOverlay.addEventListener('pointerdown', beginDrag);
for (const direction of resizeDirections) {
  const handle = resizeHandles[direction];
  if (handle) {
    handle.addEventListener('pointerdown', beginResize);
  }
}
window.addEventListener('pointermove', handlePointerMove);
window.addEventListener('pointerup', endPointerInteraction);
window.addEventListener('pointercancel', endPointerInteraction);
window.addEventListener('resize', () => {
  syncPlacementPreview();
  queueImageLoadingSync();
});
baseUrlLoadButton.addEventListener('click', loadBaseGifFromUrl);
baseUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadBaseGifFromUrl();
  }
});
handlesToggle.addEventListener('change', syncResizeHandles);
syncResizeHandles();
queueImageLoadingSync();
window.addEventListener('beforeunload', revokeUrls);

if (stageBase.complete) {
  syncPlacementPreview();
}

loadDefaultOverlayImage();
