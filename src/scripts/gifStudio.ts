import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { decodeAnimationFrames, frameSequenceInput } from '../lib/decodedFrames';
import { GifRenderer } from '../lib/GifRenderer';
import { clampOverlayDimension, maxOverlayDimension, MIN_OVERLAY_DIMENSION } from '../lib/placement';

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
const downloadButton = requireElement('download-button', HTMLButtonElement);
const xInput = requireElement('x-input', HTMLInputElement);
const yInput = requireElement('y-input', HTMLInputElement);
const widthInput = requireElement('width-input', HTMLInputElement);
const heightInput = requireElement('height-input', HTMLInputElement);

const supportedImageName = /\.(gif|jpe?g|png|webp)$/i;

// Dropped files and CORS responses do not always carry a MIME type, so the filename is a fallback signal.
const isSupportedImage = (file: File) => file.type.startsWith('image/') || supportedImageName.test(file.name);

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

/** One replaceable source (base or overlay); each new selection supersedes the previous one. */
type SourceRequests = {
  kind: 'base' | 'overlay';
  latest: number;
  fetch: AbortController | null;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  fallbackName: string;
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
let baseFile: File | null = null;
let pasteTarget: HTMLDivElement = dropzone;
let basePreviewUrl: string | null = null;
let resultUrl: string | null = null;
let overlayNaturalWidth = 0;
let overlayNaturalHeight = 0;
let activePointer: ActivePointer | null = null;
let autoRenderTimer: number | null = null;
let renderController: AbortController | null = null;
let renderSequence = 0;
const baseRequests: SourceRequests = {
  kind: 'base',
  latest: 0,
  fetch: null,
  input: baseUrlInput,
  button: baseUrlLoadButton,
  fallbackName: 'base',
};
const overlayRequests: SourceRequests = {
  kind: 'overlay',
  latest: 0,
  fetch: null,
  input: overlayUrlInput,
  button: overlayUrlLoadButton,
  fallbackName: 'overlay-image',
};
const ffmpeg = new FFmpeg();
const gifRenderer = new GifRenderer(ffmpeg, { coreURL: coreUrl, wasmURL: wasmUrl });
let lastFfmpegLog = '';
const defaultBaseSrc = `${appBase}assets/base/woman_is_talking.gif`;

ffmpeg.on('log', ({ message }) => {
  const line = message.trim();
  if (line) {
    lastFfmpegLog = `${lastFfmpegLog} ${line}`.trim().slice(-400);
  }
});

const setStatus = (message: string) => {
  statusText.textContent = message;
  statusText.hidden = !message;
};

const setSelectedFileText = (element: HTMLParagraphElement, text: string) => {
  // A polite live region: rewriting identical text would announce it again.
  if (element.textContent !== text) {
    element.textContent = text;
  }
};

const syncResizeHandles = () => {
  stageOverlay.dataset.resizeHandles = handlesToggle.checked ? 'visible' : 'hidden';
};

const loadingManagedImages = [basePreviewImage, overlayPreviewImage, stageBase, overlayImage] as const;

const syncImageLoading = () => {
  for (const image of loadingManagedImages) {
    // Viewport-relative, so a scrolled page still marks what the reader can actually see.
    image.loading = image.getBoundingClientRect().top <= window.innerHeight ? 'eager' : 'lazy';
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

const maxOverlayWidth = () => maxOverlayDimension(overlayNaturalWidth);
const maxOverlayHeight = () => maxOverlayDimension(overlayNaturalHeight);

const normalizePlacement = ({ x, y, width, height }: Placement): Placement => {
  const size = baseSize();
  const safeWidth = clampOverlayDimension(width, overlayNaturalWidth);
  const safeHeight = clampOverlayDimension(height, overlayNaturalHeight);
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

const setOverlayFile = (file: File | null, label?: string) => {
  cancelRender();
  resetResult();
  overlayFile = file;

  if (!overlayFile) {
    setSelectedFileText(selectedFile, 'No file selected.');
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
  setSelectedFileText(selectedFile, label ?? `${overlayFile.name} • ${Math.round(overlayFile.size / 1024)} KB`);
  setStatus('');
  queueImageLoadingSync();
};

const setBasePreviewSource = (src: string) => {
  basePreviewImage.src = src;
  stageBase.src = src;
  queueImageLoadingSync();
};

const setBaseFile = (file: File | null) => {
  cancelRender();
  resetResult();
  baseFile = file;

  if (!baseFile) {
    if (basePreviewUrl) {
      URL.revokeObjectURL(basePreviewUrl);
      basePreviewUrl = null;
    }
    setBasePreviewSource(defaultBaseSrc);
    setSelectedFileText(baseSelectedFile, 'Using default base GIF.');
    if (overlayFile) {
      scheduleRender(0);
    }
    return;
  }

  if (basePreviewUrl) {
    URL.revokeObjectURL(basePreviewUrl);
  }

  basePreviewUrl = URL.createObjectURL(baseFile);
  setBasePreviewSource(basePreviewUrl);
  setSelectedFileText(baseSelectedFile, `${baseFile.name} • ${Math.round(baseFile.size / 1024)} KB`);
};

const showResult = (blob: Blob, filename: string) => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
  }

  resultUrl = URL.createObjectURL(blob);
  downloadLink.href = resultUrl;
  downloadLink.download = filename;
  downloadButton.disabled = false;
  downloadButton.classList.remove('disabled');
  downloadButton.removeAttribute('aria-disabled');
};

const resetResult = () => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }

  downloadLink.removeAttribute('href');
  downloadButton.disabled = true;
  downloadButton.classList.add('disabled');
  downloadButton.setAttribute('aria-disabled', 'true');
};

const cancelScheduledRender = () => {
  if (autoRenderTimer) {
    window.clearTimeout(autoRenderTimer);
    autoRenderTimer = null;
  }
};

/** Drop any pending or running render; a superseded render can no longer write status or results. */
const cancelRender = () => {
  cancelScheduledRender();
  renderController?.abort();
  renderController = null;
};

const ffmpegDetail = () => {
  const detail = lastFfmpegLog
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Last message repeated/.test(line))
    .pop();
  return detail ? ` ${detail.slice(0, 200)}` : '';
};

const renderGif = async () => {
  if (!overlayFile) {
    return;
  }
  const activeOverlayFile = overlayFile;

  cancelRender();
  const controller = new AbortController();
  renderController = controller;
  // Every path that supersedes this render aborts it, so `signal.aborted` is its identity check.
  const { signal } = controller;
  const requestId = ++renderSequence;
  resetResult();
  setStatus('Loading browser renderer...');

  try {
    await gifRenderer.prepare();
    signal.throwIfAborted();

    setStatus('Rendering GIF in this browser...');
    let activeBaseFile = baseFile;
    if (!activeBaseFile) {
      const response = await fetch(defaultBaseSrc, { signal });
      if (!response.ok) throw new Error('Default base GIF could not be loaded.');
      activeBaseFile = new File([await response.blob()], 'woman_is_talking.gif', { type: 'image/gif' });
    }

    // Typed values can be fractional or past the resize limit; FFmpeg gets the same clamped box the editor shows.
    const placement = normalizePlacement(placementValues());
    const [x, y, width, height] = [placement.x, placement.y, placement.width, placement.height].map(Math.round);
    const filterGraph = `[1:v]scale=${width}:${height}[overlay];[0:v][overlay]overlay=${x}:${y},split[gif][palette_src];[palette_src]palettegen[palette];[gif][palette]paletteuse`;
    // FFmpeg transfers the buffer to its worker, so every FFmpeg call reads the bytes again.
    const overlaySource = async () => ({ name: activeOverlayFile.name, data: await fetchFile(activeOverlayFile) });

    let notice = '';
    lastFfmpegLog = '';
    let data: Uint8Array | string;
    try {
      data = await gifRenderer.render({
        id: requestId,
        base: { name: activeBaseFile.name, data: await fetchFile(activeBaseFile) },
        overlay: await overlaySource(),
        filterGraph,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = `${errorMessage(error, 'Render failed in this browser.')}${ffmpegDetail()}`;

      // FFmpeg's core cannot open every image the browser can (animated WebP, AVIF). Only when the base
      // itself is what FFmpeg rejected is it worth handing FFmpeg browser-decoded frames instead.
      const baseSource = { name: activeBaseFile.name, data: await fetchFile(activeBaseFile) };
      if (await gifRenderer.decodes(requestId, baseSource, signal)) {
        throw new Error(failure, { cause: error });
      }
      const decoded = await decodeAnimationFrames(activeBaseFile, signal);
      if (!decoded) {
        throw new Error(failure, { cause: error });
      }

      signal.throwIfAborted();
      setStatus('Converting this base animation for the browser renderer...');
      const frameName = (index: number) => `frame-${requestId}-${String(index).padStart(4, '0')}.png`;
      const sequence = frameSequenceInput(
        decoded.frames.map((frame, index) => ({ name: frameName(index), durationMs: frame.durationMs })),
      );
      lastFfmpegLog = '';

      try {
        data = await gifRenderer.render({
          id: requestId,
          base: { name: `frames-${requestId}.txt`, data: sequence.script },
          overlay: await overlaySource(),
          filterGraph,
          inputArgs: { base: sequence.inputArgs },
          outputArgs: sequence.outputArgs,
          extraFiles: decoded.frames.map((frame, index) => ({ name: frameName(index), data: frame.data })),
          signal,
        });
      } catch (retryError) {
        if (signal.aborted) throw retryError;
        throw new Error(
          `${failure} Rendering the browser-decoded base frames failed too: ${errorMessage(retryError, 'Render failed.')}${ffmpegDetail()}`,
          { cause: retryError },
        );
      }

      if (decoded.totalFrames > decoded.frames.length) {
        notice = `Only the first ${decoded.frames.length} of ${decoded.totalFrames} base frames were rendered; longer animations are cut short to fit in browser memory.`;
      }
    }

    signal.throwIfAborted();
    const gifBytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data);
    const baseStem = activeBaseFile.name.replace(/\.[^.]+$/, '') || 'base';
    showResult(new Blob([gifBytes], { type: 'image/gif' }), `${baseStem}_overlay.gif`);
    setStatus(notice);
  } catch (error) {
    if (!signal.aborted) {
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

const handleBaseFiles = (files: File[] | FileList | null) => {
  const file = files?.[0];
  if (!file) {
    return;
  }

  if (!isSupportedImage(file)) {
    setStatus('That base file is not a GIF or image.');
    return;
  }

  supersede(baseRequests);
  setBaseFile(file);
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

/** Start a new selection for a source: abort its pending URL load; only the returned request may commit. */
const supersede = (requests: SourceRequests) => {
  requests.fetch?.abort();
  requests.fetch = null;
  requests.button.disabled = false;
  requests.latest += 1;
  return requests.latest;
};

const loadFromUrl = async (requests: SourceRequests, apply: (file: File) => void) => {
  const url = requests.input.value.trim();
  if (!url) {
    setStatus('Enter a GIF or image URL first.');
    return;
  }

  const request = supersede(requests);
  const controller = new AbortController();
  requests.fetch = controller;
  requests.button.disabled = true;
  setStatus(`Loading ${requests.kind} GIF or image...`);

  try {
    const file = await fetchRemoteFile(url, 'image/*,*/*;q=0.1', requests.fallbackName, controller.signal);
    if (request !== requests.latest) return;
    if (!isSupportedImage(file)) {
      throw new Error('URL did not return a GIF or image.');
    }
    apply(file);
  } catch (error) {
    if (request === requests.latest) {
      setStatus(errorMessage(error, `The ${requests.kind} fetch failed.`));
    }
  } finally {
    if (request === requests.latest) {
      requests.fetch = null;
      requests.button.disabled = false;
    }
  }
};

const loadBaseFromUrl = () =>
  loadFromUrl(baseRequests, (file) => {
    setBaseFile(file);
    setStatus('');
  });

const handleOverlayFiles = (files: File[] | FileList | null) => {
  const file = files?.[0];
  if (!file) {
    return;
  }

  if (!isSupportedImage(file)) {
    setStatus('That file is not a GIF or image.');
    return;
  }

  supersede(overlayRequests);
  setOverlayFile(file);
};

const handlePaste = (event: ClipboardEvent) => {
  const item = Array.from(event.clipboardData?.items ?? []).find(
    (entry) => entry.kind === 'file' && entry.type.startsWith('image/'),
  );
  const clipboardFile = item?.getAsFile();
  if (!clipboardFile) {
    return;
  }

  event.preventDefault();
  const target = pasteTarget;
  target.classList.add('is-dragging');
  window.setTimeout(() => target.classList.remove('is-dragging'), 600);

  const file = clipboardFile.name
    ? clipboardFile
    : new File([clipboardFile], `pasted-image.${clipboardFile.type.split('/')[1] || 'png'}`, {
        type: clipboardFile.type,
      });

  if (target === baseDropzone) {
    handleBaseFiles([file]);
    return;
  }
  handleOverlayFiles([file]);
};

const loadOverlayFromUrl = () => loadFromUrl(overlayRequests, (file) => setOverlayFile(file));

const loadDefaultOverlayImage = async () => {
  // An overlay the reader picks while this loads wins; only an untouched overlay gets the default.
  const request = overlayRequests.latest;
  try {
    const response = await fetch(`${appBase}pfp.webp`);
    if (!response.ok) throw new Error('Default overlay image could not be loaded.');
    const blob = await response.blob();
    if (request === overlayRequests.latest) {
      setOverlayFile(new File([blob], 'pfp.webp', { type: blob.type || 'image/webp' }), 'Using default overlay image.');
    }
  } catch (error) {
    if (request === overlayRequests.latest) {
      setStatus(errorMessage(error, 'Default overlay image could not be loaded.'));
    }
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
downloadButton.addEventListener('click', () => {
  if (downloadLink.href) {
    downloadLink.click();
  }
});
basePreviewImage.addEventListener('error', () => {
  setStatus('That base file could not be decoded by this browser.');
});
overlayPreviewImage.addEventListener('error', () => {
  setStatus('That overlay file could not be decoded by this browser.');
});

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
fileInput.addEventListener('change', () => handleOverlayFiles(fileInput.files));

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

dropzone.addEventListener('drop', (event) => handleOverlayFiles(event.dataTransfer?.files ?? null));

for (const zone of [baseDropzone, dropzone]) {
  for (const eventName of ['pointerenter', 'pointerdown', 'focusin']) {
    zone.addEventListener(eventName, () => {
      pasteTarget = zone;
    });
  }
}

document.addEventListener('paste', handlePaste);
overlayUrlLoadButton.addEventListener('click', loadOverlayFromUrl);
overlayUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadOverlayFromUrl();
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
  widthInput.max = String(maxOverlayWidth());
  heightInput.max = String(maxOverlayHeight());
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
window.addEventListener('scroll', queueImageLoadingSync, { passive: true });
baseUrlLoadButton.addEventListener('click', loadBaseFromUrl);
baseUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadBaseFromUrl();
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
