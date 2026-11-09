import templateJson from '../data/whoIsThisKidTemplate.json';
import { moveBoxInside, type Box } from '../lib/boxGeometry';
import { createGlyphSet, type GlyphData, type GlyphSet } from '../lib/textLayer';
import {
  captionWord,
  centeredCrop,
  composeFrame,
  createCaptions,
  pictureShapes,
  pictureSizeLimit,
  preparePicture,
  resolvePictureShape,
  type Captions,
  type PicturePlacement,
  type TemplatePixels,
  type WhoIsThisKidTemplate,
  type WordProblem,
} from '../lib/whoIsThisKid';
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

// JSON imports widen tuples to arrays; build_template.py writes exactly this shape.
const template = templateJson as WhoIsThisKidTemplate;

const dropzone = requireElement('picture-dropzone', HTMLDivElement);
const fileInput = requireElement('picture-file-input', HTMLInputElement);
const urlInput = requireElement('picture-url-input', HTMLInputElement);
const urlLoadButton = requireElement('picture-url-load-button', HTMLButtonElement);
const selectedFile = requireElement('picture-selected-file', HTMLParagraphElement);
const previewImage = requireElement('picture-preview-image', HTMLImageElement);
const cropStage = requireElement('picture-crop-stage', HTMLDivElement);
const cropBox = requireElement('picture-crop-box', HTMLDivElement);
const wordInput = requireElement('word-input', HTMLInputElement);
const shapeSelect = requireElement('shape-select', HTMLSelectElement);
const placementStage = requireElement('placement-stage', HTMLDivElement);
const stageOverlay = requireElement('stage-overlay', HTMLDivElement);
const stageBase = requireElement('stage-base', HTMLImageElement);
const stagePicture = requireElement('stage-picture', HTMLImageElement);
const scaleInput = requireElement('scale-input', HTMLInputElement);
const offsetXInput = requireElement('offset-x-input', HTMLInputElement);
const offsetYInput = requireElement('offset-y-input', HTMLInputElement);
const resultImage = requireElement('result-image', HTMLImageElement);
const downloadButton = requireElement('download-button', HTMLButtonElement);
const downloadLink = requireElement('download-link', HTMLAnchorElement);
const statusText = requireElement('status', HTMLParagraphElement);

const assetUrl = (file: string) => `${appBase}assets/who-is-this-kid/${file}`;
const { renderer, resetLog, logDetail } = createRenderer();
const frameBytes = template.width * template.height * 3;
const templateSize = { width: template.width, height: template.height };
const queueImageLoadingSync = manageImageLoading([previewImage, stageBase, stagePicture, resultImage]);
/** What the Result panel shows before the first render, and again when a picture cannot be used. */
const resultPlaceholder = resultImage.getAttribute('src') ?? '';
// The editor shows one frame; the picture's box there maps to a placement relative to that frame's face.
const [editorFaceX, editorFaceY, editorFace] = template.frames[template.editor.frame]?.face ?? [0, 0, 1];

let pictureFile: File | null = null;
let previewUrl: string | null = null;
let resultUrl: string | null = null;
let renderTimer: number | null = null;
let renderController: AbortController | null = null;
let renderSequence = 0;
/** Each new picture choice bumps this and aborts the pending URL fetch; only the latest may apply. */
let pictureRequest = 0;
let pictureFetch: AbortController | null = null;
let templatePixels: Promise<TemplatePixels> | null = null;
let glyphSet: Promise<GlyphSet> | null = null;
/** The captions for the last word drawn; their text layers are reused until the word changes. */
let captions: { word: string; value: Captions } | null = null;
let decodedPicture: { file: File; image: ImageData } | null = null;
let pictureSize = { width: 0, height: 0 };
/** The part of the picture that is used: a square in its natural pixels, centred until the reader crops. */
let pictureCrop: Box = { x: 0, y: 0, width: 0, height: 0 };

/** The render whose progress the status line shows; other messages (errors, fetches) have no owner. */
let statusOwner: AbortController | null = null;

const setStatus = (message: string, owner: AbortController | null = null) => {
  statusText.textContent = message;
  statusText.hidden = !message;
  statusOwner = message ? owner : null;
};

/** Run an FFmpeg step; a failure message ends with FFmpeg's last log line. */
const ffmpegStep = async <Result>(step: () => Promise<Result>, signal?: AbortSignal) => {
  resetLog();
  try {
    return await step();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${errorMessage(error, 'FFmpeg failed in this browser.')}${logDetail()}`, { cause: error });
  }
};

/** Decode one template image to raw pixels with FFmpeg, so they match what the build script read. */
const decodeAsset = async (file: string, pixelFormat: string, expectedBytes: number) => {
  const response = await fetch(assetUrl(file));
  if (!response.ok) {
    throw new Error(`The GIF template could not be loaded (${file}: ${response.status}).`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  const output = `${file}.${pixelFormat}.raw`;
  const pixels = await ffmpegStep(() =>
    renderer.run({
      files: [{ name: file, data }],
      args: ['-i', file, '-f', 'rawvideo', '-pix_fmt', pixelFormat, output],
      output,
    }),
  );
  if (!(pixels instanceof Uint8Array) || pixels.length !== expectedBytes) {
    throw new Error(`The GIF template did not decode as expected (${file}).`);
  }
  return pixels;
};

/** Decoded once per page and shared by every render; a failed load is retried by the next render. */
const loadTemplatePixels = () => {
  templatePixels ??= (async () => {
    const [patchesWidth, patchesHeight] = template.patches.size;
    return {
      frames: await decodeAsset(template.source, 'rgb24', frameBytes * template.frames.length),
      patches: await decodeAsset(template.patches.file, 'rgb24', patchesWidth * patchesHeight * 3),
    };
  })();
  templatePixels.catch(() => {
    templatePixels = null;
  });
  return templatePixels;
};

/** The caption font, fetched once when the page opens; a failed load is retried by the next render. */
const loadGlyphs = () => {
  glyphSet ??= (async () => {
    const response = await fetch(assetUrl(template.glyphs));
    if (!response.ok) {
      throw new Error(`The caption font could not be loaded (${response.status}).`);
    }
    return createGlyphSet((await response.json()) as GlyphData);
  })();
  glyphSet.catch(() => {
    glyphSet = null;
  });
  return glyphSet;
};

const captionsFor = (glyphs: GlyphSet, word: string) => {
  if (captions?.word !== word) {
    captions = { word, value: createCaptions(template, glyphs, word) };
  }
  return captions.value;
};

const wordMessage = (problem: WordProblem, word: string) => {
  switch (problem.kind) {
    case 'empty':
      return 'Type a word for the captions.';
    case 'unsupported':
      return `The caption font has no ${problem.characters.map((character) => `"${character}"`).join(', ')}.`;
    case 'too-wide':
      return `"${word}" does not fit in the captions; try a shorter word.`;
    case 'no-ink':
      return `"${word}" has nothing to draw.`;
  }
};

/** The picture's first frame as RGBA, upright per its EXIF orientation. */
const readPicture = async (file: File) => {
  if (decodedPicture?.file === file) {
    return decodedPicture.image;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  } catch (error) {
    throw new Error('That picture could not be decoded by this browser.', { cause: error });
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('This browser cannot read picture pixels.');
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    decodedPicture = { file, image };
    return image;
  } finally {
    bitmap.close();
  }
};

const roundedCrop = () => ({
  x: Math.round(pictureCrop.x),
  y: Math.round(pictureCrop.y),
  width: Math.max(1, Math.round(pictureCrop.width)),
  height: Math.max(1, Math.round(pictureCrop.height)),
});

const placementInputs = [scaleInput, offsetXInput, offsetYInput];

const placementValues = (): PicturePlacement => ({
  scale: Number(scaleInput.value),
  offsetX: Number(offsetXInput.value) / 100,
  offsetY: Number(offsetYInput.value) / 100,
});

/** The picture's box on the editor frame, as `pastePicture` places it (before its pixel rounding). */
const placementBox = ({ scale, offsetX, offsetY }: PicturePlacement): Box => {
  const width = editorFace * scale;
  const height = (width * pictureCrop.height) / (pictureCrop.width || 1);
  return {
    x: editorFaceX + offsetX * editorFace - width / 2,
    y: editorFaceY + offsetY * editorFace - editorFace * 0.08 - height / 2,
    width,
    height,
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Write the placement a dragged box stands for into the inputs, within their limits. */
const setPlacementFromBox = (box: Box) => {
  const scale = clamp(box.width / editorFace, 0.5, 4);
  const offsetX = (box.x + box.width / 2 - editorFaceX) / editorFace;
  const offsetY = (box.y + box.height / 2 + editorFace * 0.08 - editorFaceY) / editorFace;
  scaleInput.value = scale.toFixed(2);
  offsetXInput.value = String(clamp(Math.round(offsetX * 100), -200, 200));
  offsetYInput.value = String(clamp(Math.round(offsetY * 100), -200, 200));
};

const syncPlacement = () => {
  stageOverlay.hidden = !pictureSize.width;
  if (!pictureSize.width || placementInputs.some((input) => !input.validity.valid)) {
    return;
  }
  placementEditor.layout(placementBox(placementValues()));
  showCrop(stagePicture, pictureCrop, pictureSize);
};

/** Clip the editor's picture the way the render will mask it (auto needs the picture's pixels). */
const syncPreviewShape = async () => {
  const file = pictureFile;
  const selected = pictureShapes.find((value) => value === shapeSelect.value) ?? 'auto';
  let shape: string = selected;
  if (selected === 'auto' && file && pictureSize.width) {
    try {
      const image = await readPicture(file);
      shape = resolvePictureShape(image.data, image.width, image.height, roundedCrop(), 'auto');
    } catch {
      return; // the render reports undecodable pictures
    }
  }
  if (file === pictureFile) {
    stageOverlay.dataset.shape = shape;
  }
};

const placementEditor = createBoxEditor({
  stage: placementStage,
  element: stageOverlay,
  space: () => templateSize,
  current: () => placementBox(placementValues()),
  resizeOptions: () => ({
    // Width follows Size; the height comes with it in the crop's proportions.
    limits: { minWidth: editorFace * 0.5, minHeight: 1, maxWidth: editorFace * 4, maxHeight: Infinity },
    aspect: pictureCrop.width / pictureCrop.height,
  }),
  move: (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }),
  onStart: stopRenderForDrag,
  onChange: (box, done) => {
    setPlacementFromBox(box);
    syncPlacement();
    if (done) {
      scheduleRender(0);
    }
  },
  enabled: () => Boolean(pictureSize.width),
});

const cropEditor = createBoxEditor({
  stage: cropStage,
  element: cropBox,
  space: () => pictureSize,
  current: () => pictureCrop,
  resizeOptions: (start, shiftKey) => ({
    limits: {
      minWidth: Math.min(16, pictureSize.width),
      minHeight: Math.min(16, pictureSize.height),
      maxWidth: pictureSize.width,
      maxHeight: pictureSize.height,
    },
    contain: pictureSize,
    aspect: shiftKey ? start.width / start.height : null,
  }),
  move: (start, dx, dy) => moveBoxInside(start, dx, dy, pictureSize),
  onStart: stopRenderForDrag,
  onChange: (box, done) => {
    pictureCrop = box;
    cropEditor.layout(box);
    syncPlacement();
    if (done) {
      void syncPreviewShape();
      scheduleRender(0);
    }
  },
  enabled: () => Boolean(pictureSize.width),
});

/** A drag will render once it ends; a render still running would only compete with it for the main thread. */
function stopRenderForDrag() {
  cancelRender();
  if (statusOwner) {
    setStatus('');
  }
}

/** Disable the download while a new result is pending; the old one stays on screen until replaced. */
const disableDownload = () => {
  downloadLink.removeAttribute('href');
  downloadButton.disabled = true;
  downloadButton.classList.add('disabled');
  downloadButton.setAttribute('aria-disabled', 'true');
};

/** Back to the placeholder: the shown result was made from a picture that is no longer chosen. */
const resetResult = () => {
  disableDownload();
  resultImage.src = resultPlaceholder;
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
};

const showResult = (gif: Blob, filename: string) => {
  const previous = resultUrl;
  resultUrl = URL.createObjectURL(gif);
  resultImage.src = resultUrl;
  queueImageLoadingSync();
  if (previous) {
    URL.revokeObjectURL(previous);
  }
  downloadLink.href = resultUrl;
  downloadLink.download = filename;
  downloadButton.disabled = false;
  downloadButton.classList.remove('disabled');
  downloadButton.removeAttribute('aria-disabled');
};

/** Drop any pending or running render; a superseded render can no longer write status or results. */
const cancelRender = () => {
  if (renderTimer) {
    window.clearTimeout(renderTimer);
    renderTimer = null;
  }
  renderController?.abort();
  renderController = null;
};

const render = async () => {
  if (!pictureFile || !pictureCrop.width) {
    return;
  }
  const file = pictureFile;
  cancelRender();
  disableDownload();

  if (placementInputs.some((input) => !input.validity.valid)) {
    setStatus('Size must be between 0.5 and 4, and each offset between -200 and 200.');
    return;
  }
  const placement = placementValues();
  const crop = roundedCrop();
  const word = captionWord(wordInput.value);
  const shape = pictureShapes.find((value) => value === shapeSelect.value) ?? 'auto';

  const controller = new AbortController();
  renderController = controller;
  // Every path that supersedes this render aborts it, so `signal.aborted` is its identity check.
  const { signal } = controller;
  const id = ++renderSequence;
  // The render takes over the status line as it starts. A message something else writes while it
  // runs (a failed URL fetch, an unreadable file) stays up: progress and the final clear only touch
  // the line while it still shows this render's own message.
  setStatus('Loading browser renderer...', controller);
  const progress = (message: string) => {
    if (statusOwner === controller) {
      setStatus(message, controller);
    }
  };

  try {
    const glyphs = await loadGlyphs();
    signal.throwIfAborted();
    const wordCaptions = captionsFor(glyphs, word);
    wordInput.setAttribute('aria-invalid', String(Boolean(wordCaptions.problem)));
    if (wordCaptions.problem) {
      setStatus(wordMessage(wordCaptions.problem, word));
      return;
    }
    await renderer.prepare();
    signal.throwIfAborted();
    progress('Loading the GIF template...');
    const pixels = await loadTemplatePixels();
    signal.throwIfAborted();
    const image = await readPicture(file);
    signal.throwIfAborted();

    const picture = preparePicture(image.data, image.width, image.height, {
      crop,
      shape,
      maxSize: pictureSizeLimit(template, placement.scale),
    });
    const frames = new Uint8Array(frameBytes * template.frames.length);
    for (let index = 0; index < template.frames.length; index += 1) {
      if (index % 4 === 0) {
        progress(`Compositing frame ${index + 1} of ${template.frames.length}...`);
        // Let the page paint and take input between batches of frames.
        const { promise, resolve } = Promise.withResolvers<void>();
        window.setTimeout(resolve, 0);
        await promise;
        signal.throwIfAborted();
      }
      frames.set(
        composeFrame(template, pixels, index, picture, { placement, captions: wordCaptions }),
        index * frameBytes,
      );
    }

    progress('Encoding GIF...');
    const input = `who-is-this-kid-${id}.raw`;
    const output = `who-is-this-kid-${id}.gif`;
    const gif = await ffmpegStep(
      () =>
        renderer.run({
          files: [{ name: input, data: frames }],
          args: [
            ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${template.width}x${template.height}`],
            ...['-framerate', String(template.fps), '-i', input],
            ...['-lavfi', 'split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a'],
            ...['-loop', '0', output],
          ],
          output,
          signal,
        }),
      signal,
    );
    signal.throwIfAborted();

    if (!(gif instanceof Uint8Array)) {
      throw new Error('FFmpeg did not return GIF bytes.');
    }
    const stem = file.name.replace(/\.[^.]+$/, '') || 'picture';
    showResult(new Blob([new Uint8Array(gif)], { type: 'image/gif' }), `${stem}_who_is_this_kid.gif`);
    progress('');
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

const scheduleRender = (delay = 250) => {
  if (!pictureFile) {
    return;
  }
  cancelRender();
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    render();
  }, delay);
};

/** Start a new picture choice: abort a pending URL load; only the returned request may apply. */
const supersede = () => {
  pictureFetch?.abort();
  pictureFetch = null;
  urlLoadButton.disabled = false;
  pictureRequest += 1;
  return pictureRequest;
};

const setPicture = (file: File, label?: string) => {
  // The shown result belongs to the previous picture: nothing may download it from now on.
  cancelRender();
  disableDownload();
  pictureFile = file;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
  previewUrl = URL.createObjectURL(file);
  previewImage.src = previewUrl;
  stagePicture.src = previewUrl;
  const text = label ?? `${file.name} • ${Math.round(file.size / 1024)} KB`;
  // A polite live region: rewriting identical text would announce it again.
  if (selectedFile.textContent !== text) {
    selectedFile.textContent = text;
  }
  setStatus('');
};

const handleFiles = (files: File[] | FileList | null) => {
  const file = files?.[0];
  if (!file) {
    return;
  }
  if (!isSupportedImage(file)) {
    setStatus('That file is not a GIF or image.');
    return;
  }
  supersede();
  setPicture(file);
};

const loadFromUrl = async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Enter a picture URL first.');
    return;
  }

  const request = supersede();
  const controller = new AbortController();
  pictureFetch = controller;
  urlLoadButton.disabled = true;
  setStatus('Loading picture...');

  try {
    const file = await fetchRemoteFile(url, 'image/*,*/*;q=0.1', 'picture', controller.signal);
    if (request !== pictureRequest) return;
    if (!isSupportedImage(file)) {
      throw new Error('URL did not return a GIF or image.');
    }
    setPicture(file);
  } catch (error) {
    if (request === pictureRequest) {
      setStatus(errorMessage(error, 'The picture fetch failed.'));
    }
  } finally {
    if (request === pictureRequest) {
      pictureFetch = null;
      urlLoadButton.disabled = false;
    }
  }
};

const loadDefaultPicture = async () => {
  // A picture the reader picks while this loads wins; only an untouched page gets the default.
  const request = pictureRequest;
  try {
    const response = await fetch(`${appBase}pfp.webp`);
    if (!response.ok) throw new Error('Default picture could not be loaded.');
    const blob = await response.blob();
    if (request === pictureRequest) {
      setPicture(new File([blob], 'pfp.webp', { type: blob.type || 'image/webp' }), 'Using default picture.');
    }
  } catch (error) {
    if (request === pictureRequest) {
      setStatus(errorMessage(error, 'Default picture could not be loaded.'));
    }
  }
};

fileInput.addEventListener('change', () => handleFiles(fileInput.files));
bindDropzone(dropzone, handleFiles);
document.addEventListener('paste', (event) => {
  const file = pastedImage(event);
  if (!file) {
    return;
  }
  event.preventDefault();
  flashDropzone(dropzone);
  handleFiles([file]);
});
urlLoadButton.addEventListener('click', loadFromUrl);
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadFromUrl();
  }
});
previewImage.addEventListener('error', () => {
  resetResult();
  setStatus('That picture could not be decoded by this browser.');
});
// A new picture is measured, centre-cropped and rendered once its preview has loaded.
previewImage.addEventListener('load', () => {
  if (!pictureFile) {
    return;
  }
  pictureSize = { width: previewImage.naturalWidth, height: previewImage.naturalHeight };
  pictureCrop = centeredCrop(pictureSize.width, pictureSize.height);
  cropBox.hidden = false;
  cropEditor.layout(pictureCrop);
  syncPlacement();
  void syncPreviewShape();
  queueImageLoadingSync();
  scheduleRender(0);
});
wordInput.addEventListener('input', () => scheduleRender());
shapeSelect.addEventListener('change', () => {
  void syncPreviewShape();
  scheduleRender(0);
});
for (const input of placementInputs) {
  input.addEventListener('input', () => {
    syncPlacement();
    scheduleRender();
  });
}
window.addEventListener('resize', () => {
  cropEditor.layout(pictureCrop);
  syncPlacement();
});
downloadButton.addEventListener('click', () => {
  if (downloadLink.href) {
    downloadLink.click();
  }
});
window.addEventListener('beforeunload', () => {
  for (const url of [previewUrl, resultUrl]) {
    if (url) URL.revokeObjectURL(url);
  }
});

// The caption font is small; fetching it now lets the first render check the word at once.
void loadGlyphs().catch(() => {});
loadDefaultPicture();
