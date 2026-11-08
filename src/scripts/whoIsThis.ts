import templateJson from '../data/whoIsThisTemplate.json';
import {
  composeFrame,
  pictureShapes,
  pictureSizeLimit,
  preparePicture,
  type TemplatePixels,
  type WhoIsThisTemplate,
} from '../lib/whoIsThis';
import {
  appBase,
  bindDropzone,
  createRenderer,
  errorMessage,
  fetchRemoteFile,
  flashDropzone,
  isSupportedImage,
  pastedImage,
  requireElement,
} from './shared';

// JSON imports widen tuples to arrays; build_template.py writes exactly this shape.
const template = templateJson as WhoIsThisTemplate;

const dropzone = requireElement('picture-dropzone', HTMLDivElement);
const fileInput = requireElement('picture-file-input', HTMLInputElement);
const urlInput = requireElement('picture-url-input', HTMLInputElement);
const urlLoadButton = requireElement('picture-url-load-button', HTMLButtonElement);
const selectedFile = requireElement('picture-selected-file', HTMLParagraphElement);
const previewImage = requireElement('picture-preview-image', HTMLImageElement);
const wordSelect = requireElement('word-select', HTMLSelectElement);
const shapeSelect = requireElement('shape-select', HTMLSelectElement);
const scaleInput = requireElement('scale-input', HTMLInputElement);
const zoomInput = requireElement('zoom-input', HTMLInputElement);
const resultImage = requireElement('result-image', HTMLImageElement);
const downloadButton = requireElement('download-button', HTMLButtonElement);
const downloadLink = requireElement('download-link', HTMLAnchorElement);
const statusText = requireElement('status', HTMLParagraphElement);

const assetUrl = (file: string) => `${appBase}assets/who-is-this/${file}`;
const { renderer, resetLog, logDetail } = createRenderer();
const frameBytes = template.width * template.height * 3;

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
let decodedPicture: { file: File; image: ImageData } | null = null;

const setStatus = (message: string) => {
  statusText.textContent = message;
  statusText.hidden = !message;
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
    const [overlaysWidth, overlaysHeight] = template.overlays.size;
    return {
      frames: await decodeAsset(template.source, 'rgb24', frameBytes * template.frames.length),
      patches: await decodeAsset(template.patches.file, 'rgb24', patchesWidth * patchesHeight * 3),
      overlays: await decodeAsset(template.overlays.file, 'rgba', overlaysWidth * overlaysHeight * 4),
    };
  })();
  templatePixels.catch(() => {
    templatePixels = null;
  });
  return templatePixels;
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

/** Disable the download while a new result is pending; the old one stays on screen until replaced. */
const disableDownload = () => {
  downloadLink.removeAttribute('href');
  downloadButton.disabled = true;
  downloadButton.classList.add('disabled');
  downloadButton.setAttribute('aria-disabled', 'true');
};

const showResult = (gif: Blob, filename: string) => {
  const previous = resultUrl;
  resultUrl = URL.createObjectURL(gif);
  resultImage.src = resultUrl;
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
  if (!pictureFile) {
    return;
  }
  const file = pictureFile;
  cancelRender();
  disableDownload();

  if (!scaleInput.validity.valid || !zoomInput.validity.valid) {
    setStatus('Size must be between 0.5 and 4, and zoom between 0.1 and 1.');
    return;
  }
  const scale = Number(scaleInput.value);
  const zoom = Number(zoomInput.value);
  const word = wordSelect.value;
  const shape = pictureShapes.find((value) => value === shapeSelect.value) ?? 'auto';

  const controller = new AbortController();
  renderController = controller;
  // Every path that supersedes this render aborts it, so `signal.aborted` is its identity check.
  const { signal } = controller;
  const id = ++renderSequence;

  try {
    setStatus('Loading browser renderer...');
    await renderer.prepare();
    signal.throwIfAborted();
    setStatus('Loading the GIF template...');
    const pixels = await loadTemplatePixels();
    signal.throwIfAborted();
    const image = await readPicture(file);
    signal.throwIfAborted();

    const picture = preparePicture(image.data, image.width, image.height, {
      zoom,
      shape,
      maxSize: pictureSizeLimit(template, scale),
    });
    const frames = new Uint8Array(frameBytes * template.frames.length);
    for (let index = 0; index < template.frames.length; index += 1) {
      if (index % 4 === 0) {
        setStatus(`Compositing frame ${index + 1} of ${template.frames.length}...`);
        // Let the page paint and take input between batches of frames.
        const { promise, resolve } = Promise.withResolvers<void>();
        window.setTimeout(resolve, 0);
        await promise;
        signal.throwIfAborted();
      }
      frames.set(composeFrame(template, pixels, index, picture, { scale, word }), index * frameBytes);
    }

    setStatus('Encoding GIF...');
    const input = `who-is-this-${id}.raw`;
    const output = `who-is-this-${id}.gif`;
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
    showResult(new Blob([new Uint8Array(gif)], { type: 'image/gif' }), `${stem}_who_is_this.gif`);
    setStatus('');
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
  pictureFile = file;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
  previewUrl = URL.createObjectURL(file);
  previewImage.src = previewUrl;
  const text = label ?? `${file.name} • ${Math.round(file.size / 1024)} KB`;
  // A polite live region: rewriting identical text would announce it again.
  if (selectedFile.textContent !== text) {
    selectedFile.textContent = text;
  }
  setStatus('');
  scheduleRender(0);
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
  setStatus('That picture could not be decoded by this browser.');
});
for (const select of [wordSelect, shapeSelect]) {
  select.addEventListener('change', () => scheduleRender(0));
}
for (const input of [scaleInput, zoomInput]) {
  input.addEventListener('input', () => scheduleRender());
}
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

loadDefaultPicture();
