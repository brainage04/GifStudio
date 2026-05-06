const baseDropzone = document.getElementById("base-dropzone");
const baseFileInput = document.getElementById("base-file-input");
const baseUrlInput = document.getElementById("base-url-input");
const baseUrlLoadButton = document.getElementById("base-url-load-button");
const baseSelectedFile = document.getElementById("base-selected-file");
const basePreviewImage = document.getElementById("base-preview-image");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const overlayUrlInput = document.getElementById("overlay-url-input");
const overlayUrlLoadButton = document.getElementById("overlay-url-load-button");
const selectedFile = document.getElementById("selected-file");
const overlayPreview = document.getElementById("overlay-preview");
const overlayPreviewImage = document.getElementById("overlay-preview-image");
const placementStage = document.getElementById("placement-stage");
const stageBase = document.getElementById("stage-base");
const stageOverlay = document.getElementById("stage-overlay");
const overlayImage = document.getElementById("overlay-image");
const renderButton = document.getElementById("render-button");
const statusText = document.getElementById("status");
const resultFrame = document.getElementById("result-frame");
const resultImage = document.getElementById("result-image");
const resultPlaceholder = document.getElementById("result-placeholder");
const downloadLink = document.getElementById("download-link");
const xInput = document.getElementById("x-input");
const yInput = document.getElementById("y-input");
const widthInput = document.getElementById("width-input");
const heightInput = document.getElementById("height-input");

const MIN_OVERLAY_DIMENSION = 16;
const MAX_OVERLAY_SCALE = 4;
const resizeDirections = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const resizeHandles = new Map();

resizeDirections.forEach((direction) => {
  const handle = document.createElement("div");
  handle.className = `resize-handle resize-handle-${direction}`;
  handle.id = `resize-handle-${direction}`;
  handle.dataset.direction = direction;
  handle.setAttribute("aria-hidden", "true");
  resizeHandles.set(direction, handle);
  stageOverlay.append(handle);
});

let overlayFile = null;
let overlayPreviewUrl = null;
let baseGifFile = null;
let basePreviewUrl = null;
let resultUrl = null;
let overlayNaturalWidth = 0;
let overlayNaturalHeight = 0;
let activePointer = null;
let autoRenderTimer = null;
let renderController = null;
let renderSequence = 0;
let baseFetchController = null;
let overlayFetchController = null;

const setStatus = (message) => {
  statusText.textContent = message;
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

const getPlacementValues = () => ({
  x: Number(xInput.value) || 0,
  y: Number(yInput.value) || 0,
  width: Math.max(Number(widthInput.value) || 1, 1),
  height: Math.max(Number(heightInput.value) || 1, 1),
});

const getBaseSize = () => ({
  width: stageBase.naturalWidth || 400,
  height: stageBase.naturalHeight || 218,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const getMaxOverlayWidth = () => Math.max(overlayNaturalWidth * MAX_OVERLAY_SCALE, MIN_OVERLAY_DIMENSION);
const getMaxOverlayHeight = () => Math.max(overlayNaturalHeight * MAX_OVERLAY_SCALE, MIN_OVERLAY_DIMENSION);

const normalizePlacement = ({ x, y, width, height }) => {
  const { width: baseWidth, height: baseHeight } = getBaseSize();
  const safeWidth = Math.max(width || 1, 1);
  const safeHeight = Math.max(height || 1, 1);
  const minVisibleX = Math.min(safeWidth, Math.max(20, baseWidth * 0.05));
  const minVisibleY = Math.min(safeHeight, Math.max(20, baseHeight * 0.05));

  return {
    x: clamp(x || 0, minVisibleX - safeWidth, baseWidth - minVisibleX),
    y: clamp(y || 0, minVisibleY - safeHeight, baseHeight - minVisibleY),
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

  const { width: baseWidth, height: baseHeight } = getBaseSize();
  const { x, y, width, height } = normalizePlacement(getPlacementValues());
  const scale = stageRect.width / baseWidth;

  stageOverlay.hidden = false;
  stageOverlay.style.left = `${x * scale}px`;
  stageOverlay.style.top = `${y * scale}px`;
  stageOverlay.style.width = `${width * scale}px`;
  stageOverlay.style.height = `${height * scale}px`;
  placementStage.style.aspectRatio = `${baseWidth} / ${baseHeight}`;
};

const setOverlayFile = (file) => {
  overlayFile = file;
  renderButton.disabled = !overlayFile;

  if (!overlayFile) {
    selectedFile.textContent = "No file selected.";
    overlayPreview.hidden = true;
    stageOverlay.hidden = true;
    setStatus("Waiting for an overlay image.");
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
  setStatus("Ready to render. Drag to move. Use any edge or corner to resize.");
};

const setBasePreviewSource = (src) => {
  basePreviewImage.src = src;
  stageBase.src = src;
};

const setBaseGifFile = (file) => {
  baseGifFile = file;

  if (!baseGifFile) {
    if (basePreviewUrl) {
      URL.revokeObjectURL(basePreviewUrl);
      basePreviewUrl = null;
    }
    setBasePreviewSource("/base.gif");
    baseSelectedFile.textContent = "Using default base GIF.";
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

const showResult = (blob) => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
  }
  resultUrl = URL.createObjectURL(blob);
  resultImage.src = resultUrl;
  resultImage.hidden = false;
  resultPlaceholder.hidden = true;
  resultFrame.classList.remove("empty");
  downloadLink.href = resultUrl;
  downloadLink.download = "woman_is_talking_overlay.gif";
  downloadLink.classList.remove("disabled");
};

const resetResult = () => {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  resultImage.hidden = true;
  resultImage.removeAttribute("src");
  resultPlaceholder.hidden = false;
  resultFrame.classList.add("empty");
  downloadLink.removeAttribute("href");
  downloadLink.classList.add("disabled");
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

  cancelScheduledRender();
  if (renderController) {
    renderController.abort();
  }

  renderController = new AbortController();
  const requestId = ++renderSequence;
  renderButton.disabled = true;
  setStatus("Rendering GIF...");

  const formData = new FormData();
  formData.append("overlay", overlayFile);
  if (baseGifFile) {
    formData.append("baseGif", baseGifFile);
  }
  formData.append("x", xInput.value);
  formData.append("y", yInput.value);
  formData.append("width", widthInput.value);
  formData.append("height", heightInput.value);

  try {
    const response = await fetch("/api/render", {
      method: "POST",
      body: formData,
      signal: renderController.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Render failed." }));
      throw new Error(payload.error || "Render failed.");
    }

    const blob = await response.blob();
    if (requestId !== renderSequence) {
      return;
    }
    showResult(blob);
    setStatus("Render complete.");
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    setStatus(error.message || "Render failed.");
  } finally {
    if (requestId === renderSequence) {
      renderController = null;
      renderButton.disabled = !overlayFile;
    }
  }
};

const scheduleRender = (delay = 250) => {
  if (!overlayFile) {
    return;
  }
  cancelScheduledRender();
  autoRenderTimer = window.setTimeout(() => {
    autoRenderTimer = null;
    renderGif();
  }, delay);
};

const handleBaseFiles = (files) => {
  const [file] = files;
  if (!file) {
    return;
  }

  const looksLikeGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
  if (!looksLikeGif) {
    setStatus("That base file is not a GIF.");
    return;
  }

  resetResult();
  setBaseGifFile(file);
  setStatus("Base GIF loaded.");
};

const loadBaseGifFromUrl = async () => {
  const url = baseUrlInput.value.trim();
  if (!url) {
    setStatus("Enter a GIF URL first.");
    return;
  }

  if (baseFetchController) {
    baseFetchController.abort();
  }

  baseFetchController = new AbortController();
  baseUrlLoadButton.disabled = true;
  setStatus("Loading base GIF...");

  try {
    const response = await fetch("/api/fetch-base-gif", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: baseFetchController.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Base GIF fetch failed." }));
      throw new Error(payload.error || "Base GIF fetch failed.");
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "base.gif";
    const file = new File([blob], filename, { type: "image/gif" });
    resetResult();
    setBaseGifFile(file);
    setStatus("Base GIF loaded.");
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    setStatus(error.message || "Base GIF fetch failed.");
  } finally {
    baseFetchController = null;
    baseUrlLoadButton.disabled = false;
  }
};

const handleFiles = (files) => {
  const [file] = files;
  if (!file) {
    return;
  }
  if (!file.type.startsWith("image/")) {
    setStatus("That file is not an image.");
    return;
  }
  resetResult();
  setOverlayFile(file);
};

const setOverlayBlob = (blob, filename) => {
  const file = new File([blob], filename || "overlay-image", {
    type: blob.type || "image/png",
  });
  handleFiles([file]);
};

const loadOverlayImageFromUrl = async () => {
  const url = overlayUrlInput.value.trim();
  if (!url) {
    setStatus("Enter an image URL first.");
    return;
  }

  if (overlayFetchController) {
    overlayFetchController.abort();
  }

  overlayFetchController = new AbortController();
  overlayUrlLoadButton.disabled = true;
  setStatus("Loading overlay image...");

  try {
    const response = await fetch("/api/fetch-overlay-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: overlayFetchController.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Overlay image fetch failed." }));
      throw new Error(payload.error || "Overlay image fetch failed.");
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "overlay-image";
    setOverlayBlob(blob, filename);
    setStatus("Overlay image loaded.");
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    setStatus(error.message || "Overlay image fetch failed.");
  } finally {
    overlayFetchController = null;
    overlayUrlLoadButton.disabled = false;
  }
};

const loadDefaultOverlayImage = async () => {
  try {
    const response = await fetch("/default-overlay-image", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Default overlay image could not be loaded.");
    }

    const blob = await response.blob();
    setOverlayBlob(blob, "brainage.jpg");
    selectedFile.textContent = "Using default overlay image.";
  } catch (error) {
    setStatus(error.message || "Default overlay image could not be loaded.");
  }
};

const updatePlacementInputs = ({ x, y, width, height }, options = {}) => {
  const { schedule = true } = options;
  const normalized = normalizePlacement({ x, y, width, height });
  xInput.value = String(Math.round(normalized.x));
  yInput.value = String(Math.round(normalized.y));
  widthInput.value = String(Math.round(normalized.width));
  heightInput.value = String(Math.round(normalized.height));
  syncPlacementPreview();
  if (schedule) {
    scheduleRender();
  }
};

const beginDrag = (event) => {
  if (!overlayFile || event.target.classList.contains("resize-handle")) {
    return;
  }

  const stageRect = placementStage.getBoundingClientRect();
  const { width: baseWidth } = getBaseSize();
  const { x, y } = getPlacementValues();
  activePointer = {
    mode: "drag",
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: x,
    startY: y,
    stageScale: stageRect.width / baseWidth,
  };
  stageOverlay.setPointerCapture(event.pointerId);
};

const beginResize = (event) => {
  if (!overlayFile || !overlayNaturalWidth || !overlayNaturalHeight) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
  const stageRect = placementStage.getBoundingClientRect();
  const { width: baseWidth } = getBaseSize();
  const { x, y, width, height } = getPlacementValues();
  const direction = event.target.dataset.direction;
  if (!direction) {
    return;
  }
  activePointer = {
    mode: "resize",
    direction,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: x,
    startY: y,
    startWidth: width,
    startHeight: height,
    stageScale: stageRect.width / baseWidth,
  };
  event.target.setPointerCapture(event.pointerId);
};

const handlePointerMove = (event) => {
  if (!activePointer || event.pointerId !== activePointer.pointerId) {
    return;
  }

  if (activePointer.mode === "drag") {
    const deltaX = (event.clientX - activePointer.startClientX) / activePointer.stageScale;
    const deltaY = (event.clientY - activePointer.startClientY) / activePointer.stageScale;
    updatePlacementInputs({
      x: activePointer.startX + deltaX,
      y: activePointer.startY + deltaY,
      width: getPlacementValues().width,
      height: getPlacementValues().height,
    }, { schedule: false });
    return;
  }

  const deltaX = (event.clientX - activePointer.startClientX) / activePointer.stageScale;
  const deltaY = (event.clientY - activePointer.startClientY) / activePointer.stageScale;
  const direction = activePointer.direction;
  const maxWidth = getMaxOverlayWidth();
  const maxHeight = getMaxOverlayHeight();
  let x = activePointer.startX;
  let y = activePointer.startY;
  let width = activePointer.startWidth;
  let height = activePointer.startHeight;

  if (direction.includes("e")) {
    width = clamp(activePointer.startWidth + deltaX, MIN_OVERLAY_DIMENSION, maxWidth);
  }

  if (direction.includes("s")) {
    height = clamp(activePointer.startHeight + deltaY, MIN_OVERLAY_DIMENSION, maxHeight);
  }

  if (direction.includes("w")) {
    width = clamp(activePointer.startWidth - deltaX, MIN_OVERLAY_DIMENSION, maxWidth);
    x = activePointer.startX + (activePointer.startWidth - width);
  }

  if (direction.includes("n")) {
    height = clamp(activePointer.startHeight - deltaY, MIN_OVERLAY_DIMENSION, maxHeight);
    y = activePointer.startY + (activePointer.startHeight - height);
  }

  if (event.shiftKey && direction.length === 2 && overlayNaturalWidth && overlayNaturalHeight) {
    const aspectRatio = overlayNaturalWidth / overlayNaturalHeight;
    const anchorX = direction.includes("w")
      ? activePointer.startX + activePointer.startWidth
      : activePointer.startX;
    const anchorY = direction.includes("n")
      ? activePointer.startY + activePointer.startHeight
      : activePointer.startY;
    const widthChange = Math.abs(width - activePointer.startWidth);
    const heightChange = Math.abs(height - activePointer.startHeight);

    if (widthChange >= heightChange) {
      width = clamp(width, MIN_OVERLAY_DIMENSION, maxWidth);
      height = clamp(width / aspectRatio, MIN_OVERLAY_DIMENSION, maxHeight);
      width = clamp(height * aspectRatio, MIN_OVERLAY_DIMENSION, maxWidth);
    } else {
      height = clamp(height, MIN_OVERLAY_DIMENSION, maxHeight);
      width = clamp(height * aspectRatio, MIN_OVERLAY_DIMENSION, maxWidth);
      height = clamp(width / aspectRatio, MIN_OVERLAY_DIMENSION, maxHeight);
    }

    x = direction.includes("w") ? anchorX - width : anchorX;
    y = direction.includes("n") ? anchorY - height : anchorY;
  }

  updatePlacementInputs({
    x,
    y,
    width,
    height,
  }, { schedule: false });
};

const endPointerInteraction = (event) => {
  if (!activePointer || event.pointerId !== activePointer.pointerId) {
    return;
  }

  if (activePointer.mode === "drag") {
    stageOverlay.releasePointerCapture(event.pointerId);
  } else {
    const handle = resizeHandles.get(activePointer.direction);
    if (handle?.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }
  activePointer = null;
  scheduleRender(0);
};

baseFileInput.addEventListener("change", (event) => {
  handleBaseFiles(event.target.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  baseDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    baseDropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  baseDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    baseDropzone.classList.remove("is-dragging");
  });
});

baseDropzone.addEventListener("drop", (event) => {
  handleBaseFiles(event.dataTransfer.files);
});

fileInput.addEventListener("change", (event) => {
  handleFiles(event.target.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
});

dropzone.addEventListener("drop", (event) => {
  handleFiles(event.dataTransfer.files);
});

overlayUrlLoadButton.addEventListener("click", loadOverlayImageFromUrl);
overlayUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadOverlayImageFromUrl();
  }
});

stageBase.addEventListener("load", () => {
  syncPlacementPreview();
  if (overlayFile) {
    scheduleRender(0);
  }
});

overlayImage.addEventListener("load", () => {
  overlayNaturalWidth = overlayImage.naturalWidth;
  overlayNaturalHeight = overlayImage.naturalHeight;
  widthInput.value = String(Math.round(overlayNaturalWidth / 2));
  heightInput.value = String(Math.round(overlayNaturalHeight / 2));
  syncPlacementPreview();
  scheduleRender(0);
});

[xInput, yInput, widthInput, heightInput].forEach((input) => {
  input.addEventListener("input", () => {
    updatePlacementInputs(getPlacementValues());
  });
});

stageOverlay.addEventListener("pointerdown", beginDrag);
resizeHandles.forEach((handle) => {
  handle.addEventListener("pointerdown", beginResize);
});
window.addEventListener("pointermove", handlePointerMove);
window.addEventListener("pointerup", endPointerInteraction);
window.addEventListener("pointercancel", endPointerInteraction);
window.addEventListener("resize", syncPlacementPreview);
baseUrlLoadButton.addEventListener("click", loadBaseGifFromUrl);
baseUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadBaseGifFromUrl();
  }
});

renderButton.addEventListener("click", async () => {
  renderGif();
});

loadDefaultOverlayImage();

window.addEventListener("beforeunload", revokeUrls);
