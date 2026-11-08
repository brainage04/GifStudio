import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { GifRenderer } from '../lib/GifRenderer';

export const appBase = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/`;

export const requireElement = <ElementType extends HTMLElement>(
  id: string,
  constructor: new (...args: never[]) => ElementType,
) => {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing #${id}`);
  }
  return element;
};

export const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

const supportedImageName = /\.(gif|jpe?g|png|webp)$/i;

// Dropped files and CORS responses do not always carry a MIME type, so the filename is a fallback signal.
export const isSupportedImage = (file: File) => file.type.startsWith('image/') || supportedImageName.test(file.name);

const filenameFromUrl = (value: string, fallback: string) => {
  try {
    const name = new URL(value).pathname.split('/').pop();
    return name || fallback;
  } catch {
    return fallback;
  }
};

export const fetchRemoteFile = async (value: string, accept: string, fallback: string, signal: AbortSignal) => {
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

/** Highlight `zone` while files are dragged over it and hand dropped files to `onFiles`. */
export const bindDropzone = (zone: HTMLElement, onFiles: (files: FileList | null) => void) => {
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragging');
    });
  }
  zone.addEventListener('drop', (event) => onFiles(event.dataTransfer?.files ?? null));
};

/** The image file in a paste event, named after its type when the clipboard gave it no name. */
export const pastedImage = (event: ClipboardEvent) => {
  const item = Array.from(event.clipboardData?.items ?? []).find(
    (entry) => entry.kind === 'file' && entry.type.startsWith('image/'),
  );
  const clipboardFile = item?.getAsFile();
  if (!clipboardFile) {
    return null;
  }
  return clipboardFile.name
    ? clipboardFile
    : new File([clipboardFile], `pasted-image.${clipboardFile.type.split('/')[1] || 'png'}`, {
        type: clipboardFile.type,
      });
};

/** Flash `zone` the way a drag does, to show where a paste went. */
export const flashDropzone = (zone: HTMLElement) => {
  zone.classList.add('is-dragging');
  window.setTimeout(() => zone.classList.remove('is-dragging'), 600);
};

/**
 * Load `images` eagerly when they start in the first screenful of the page and lazily below it (what
 * Astro's audit expects). Layout shifts as images load and panels resize, so call the returned
 * function after anything that can move them; window resizes are handled here.
 */
export const manageImageLoading = (images: readonly HTMLImageElement[]) => {
  const sync = () => {
    for (const image of images) {
      image.loading = image.getBoundingClientRect().top + window.scrollY < window.innerHeight ? 'eager' : 'lazy';
    }
  };
  const queue = () => {
    window.requestAnimationFrame(sync);
  };
  window.addEventListener('resize', queue);
  queue();
  return queue;
};

/** The page's FFmpeg renderer, plus the tail of FFmpeg's log for error messages. */
export const createRenderer = () => {
  const ffmpeg = new FFmpeg();
  let lastLog = '';
  ffmpeg.on('log', ({ message }) => {
    const line = message.trim();
    if (line) {
      lastLog = `${lastLog} ${line}`.trim().slice(-400);
    }
  });

  return {
    renderer: new GifRenderer(ffmpeg, { coreURL: coreUrl, wasmURL: wasmUrl }),
    resetLog: () => {
      lastLog = '';
    },
    /** The last meaningful FFmpeg log line, with a leading space, or ''. */
    logDetail: () => {
      const detail = lastLog
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line && !/^Last message repeated/.test(line))
        .pop();
      return detail ? ` ${detail.slice(0, 200)}` : '';
    },
  };
};
