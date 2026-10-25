const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Ctrl/Cmd+V on the signed-in Core page. Image-only clipboards (a screenshot
 * has no text, so the textarea never receives a paste) are read here because
 * the client denies clipboard-read to the page. A clipboard that already has
 * text is left to the native paste.
 */
export function clipboardImageForPaste(input, clipboard, pageUrl, coreOrigin) {
  try {
    if (!input || input.type !== "keyDown" || String(input.key).toLowerCase() !== "v") return null;
    if (!(input.control || input.meta) || input.alt || input.shift || input.isAutoRepeat) return null;
    if (!coreOrigin || !pageUrl || new URL(pageUrl).origin !== coreOrigin) return null;
    if (String(clipboard.readText?.() ?? "").trim()) return null;
    const image = clipboard.readImage?.();
    if (!image || image.isEmpty?.()) return null;
    const png = image.toPNG?.();
    if (!png || png.length < 1 || png.length > MAX_IMAGE_BYTES) return null;
    return { name: "截图.png", type: "image/png", bytes: png };
  } catch {
    return null;
  }
}

export function installClipboardImagePaste(webContents, clipboard, getOrigin) {
  const onInput = (event, input) => {
    let pageUrl = "";
    try { pageUrl = webContents.getURL(); } catch { pageUrl = ""; }
    const image = clipboardImageForPaste(input, clipboard, pageUrl, getOrigin());
    if (!image) return;
    event.preventDefault();
    webContents.send("nex:clipboard-image", image);
  };
  webContents.on("before-input-event", onInput);
  return () => webContents.removeListener("before-input-event", onInput);
}
