import { fetchFile } from '@ffmpeg/util';
// FFmpeg renders from the original GIF; the page shows Astro's optimised copy of it.
import defaultBaseSrc from '../assets/base/woman_is_talking.gif?url';
import { decodeAnimationFrames, frameSequenceInput } from '../lib/decodedFrames';
import { moveBoxInside, type Box } from '../lib/boxGeometry';
import { clampOverlayDimension, maxOverlayDimension, MIN_OVERLAY_DIMENSION } from '../lib/placement';
import { createBoxEditor, showCrop } from './boxEditor';
import {
  appBase,
  bindDropzone,
  createRenderer,
  errorMessage,
  fetchRemoteFile,
  flashDropzone,
  isSupportedImage,
  manageImageLoading,
  pastedImage,
  requireElement,
} from './shared';

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
const overlayCropStage = requireElement('overlay-crop-stage', HTMLDivElement);
const overlayCropBox = requireElement('overlay-crop-box', HTMLDivElement);
const handlesToggle = requireElement('handles-toggle', HTMLInputElement);
const statusText = requireElement('status', HTMLParagraphElement);
const downloadLink = requireElement('download-link', HTMLAnchorElement);
const downloadButton = requireElement('download-button', HTMLButtonElement);
const xInput = requireElement('x-input', HTMLInputElement);
const yInput = requireElement('y-input', HTMLInputElement);
const widthInput = requireElement('width-input', HTMLInputElement);
const heightInput = requireElement('height-input', HTMLInputElement);

type Placement = Box;

/** One replaceable source (base or overlay); each new selection supersedes the previous one. */
type SourceRequests = {
  kind: 'base' | 'overlay';
  latest: number;
  fetch: AbortController | null;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  fallbackName: string;
};

let overlayFile: File | null = null;
let overlayPreviewUrl: string | null = null;
let baseFile: File | null = null;
let pasteTarget: HTMLDivElement = dropzone;
let basePreviewUrl: string | null = null;
let resultUrl: string | null = null;
let overlayNaturalWidth = 0;
let overlayNaturalHeight = 0;
/** The part of the overlay that is used, in its natural pixels; the whole overlay until cropped. */
let overlayCrop: Box = { x: 0, y: 0, width: 0, height: 0 };
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
const { renderer: gifRenderer, resetLog, logDetail: ffmpegDetail } = createRenderer();
const defaultBasePreviewSrc = basePreviewImage.getAttribute('src') ?? defaultBaseSrc;

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

const queueImageLoadingSync = manageImageLoading([basePreviewImage, overlayPreviewImage, stageBase, overlayImage]);

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

const maxOverlayWidth = () => maxOverlayDimension(overlayCrop.width);
const maxOverlayHeight = () => maxOverlayDimension(overlayCrop.height);

const normalizePlacement = ({ x, y, width, height }: Placement): Placement => {
  const size = baseSize();
  const safeWidth = clampOverlayDimension(width, overlayCrop.width);
  const safeHeight = clampOverlayDimension(height, overlayCrop.height);
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
  if (!overlayFile || !overlayCrop.width || !overlayCrop.height) {
    stageOverlay.hidden = true;
    return;
  }

  const stageRect = placementStage.getBoundingClientRect();
  if (!stageRect.width) {
    return;
  }

  const size = baseSize();
  stageOverlay.hidden = false;
  placementEditor.layout(normalizePlacement(placementValues()));
  showCrop(overlayImage, overlayCrop, { width: overlayNaturalWidth, height: overlayNaturalHeight });
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
    setBasePreviewSource(defaultBasePreviewSrc);
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
    const [cropX, cropY, cropWidth, cropHeight] = [
      overlayCrop.x,
      overlayCrop.y,
      overlayCrop.width,
      overlayCrop.height,
    ].map(Math.round);
    const crop =
      cropWidth === overlayNaturalWidth && cropHeight === overlayNaturalHeight
        ? ''
        : `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},`;
    const filterGraph = `[1:v]${crop}scale=${width}:${height}[overlay];[0:v][overlay]overlay=${x}:${y},split[gif][palette_src];[palette_src]palettegen[palette];[gif][palette]paletteuse`;
    // FFmpeg transfers the buffer to its worker, so every FFmpeg call reads the bytes again.
    const overlaySource = async () => ({ name: activeOverlayFile.name, data: await fetchFile(activeOverlayFile) });

    let notice = '';
    resetLog();
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
      resetLog();

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
  const file = pastedImage(event);
  if (!file) {
    return;
  }

  event.preventDefault();
  const target = pasteTarget;
  flashDropzone(target);

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

const placementEditor = createBoxEditor({
  stage: placementStage,
  element: stageOverlay,
  space: baseSize,
  current: () => normalizePlacement(placementValues()),
  resizeOptions: (_start, shiftKey) => ({
    limits: {
      minWidth: MIN_OVERLAY_DIMENSION,
      minHeight: MIN_OVERLAY_DIMENSION,
      maxWidth: maxOverlayWidth(),
      maxHeight: maxOverlayHeight(),
    },
    // Shift keeps the (cropped) overlay's own proportions.
    aspect: shiftKey ? overlayCrop.width / overlayCrop.height : null,
  }),
  move: (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }),
  onChange: (box, done) => {
    if (done) {
      scheduleRender(0);
    } else {
      updatePlacementInputs(box, { schedule: false });
    }
  },
  enabled: () => Boolean(overlayFile),
});

const overlayNaturalSize = () => ({ width: overlayNaturalWidth, height: overlayNaturalHeight });

const cropEditor = createBoxEditor({
  stage: overlayCropStage,
  element: overlayCropBox,
  space: overlayNaturalSize,
  current: () => overlayCrop,
  resizeOptions: (start, shiftKey) => ({
    limits: {
      minWidth: Math.min(MIN_OVERLAY_DIMENSION, overlayNaturalWidth),
      minHeight: Math.min(MIN_OVERLAY_DIMENSION, overlayNaturalHeight),
      maxWidth: overlayNaturalWidth,
      maxHeight: overlayNaturalHeight,
    },
    contain: overlayNaturalSize(),
    aspect: shiftKey ? start.width / start.height : null,
  }),
  move: (start, dx, dy) => moveBoxInside(start, dx, dy, overlayNaturalSize()),
  onChange: (box, done) => setOverlayCrop(box, done),
  enabled: () => Boolean(overlayFile && overlayNaturalWidth),
});

/** Use `crop` of the overlay; the placed overlay keeps its width and takes the crop's proportions. */
function setOverlayCrop(crop: Box, done: boolean) {
  const placement = placementValues();
  overlayCrop = crop;
  cropEditor.layout(crop);
  widthInput.max = String(maxOverlayWidth());
  heightInput.max = String(maxOverlayHeight());
  updatePlacementInputs({ ...placement, height: (placement.width * crop.height) / crop.width }, { schedule: done });
}

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

bindDropzone(baseDropzone, handleBaseFiles);
fileInput.addEventListener('change', () => handleOverlayFiles(fileInput.files));
bindDropzone(dropzone, handleOverlayFiles);

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
  overlayCrop = { x: 0, y: 0, width: overlayNaturalWidth, height: overlayNaturalHeight };
  overlayCropBox.hidden = false;
  cropEditor.layout(overlayCrop);
  widthInput.max = String(maxOverlayWidth());
  heightInput.max = String(maxOverlayHeight());
  widthInput.value = String(Math.round(overlayNaturalWidth / 2));
  heightInput.value = String(Math.round(overlayNaturalHeight / 2));
  syncPlacementPreview();
  scheduleRender(0);
  queueImageLoadingSync();
});

// The preview's rendered size is only known once it has loaded.
overlayPreviewImage.addEventListener('load', () => cropEditor.layout(overlayCrop));

for (const input of [xInput, yInput, widthInput, heightInput]) {
  input.addEventListener('input', () => updatePlacementInputs(placementValues()));
}

window.addEventListener('resize', () => {
  syncPlacementPreview();
  cropEditor.layout(overlayCrop);
});
baseUrlLoadButton.addEventListener('click', loadBaseFromUrl);
baseUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadBaseFromUrl();
  }
});
handlesToggle.addEventListener('change', syncResizeHandles);
syncResizeHandles();
window.addEventListener('beforeunload', revokeUrls);

if (stageBase.complete) {
  syncPlacementPreview();
}

loadDefaultOverlayImage();
