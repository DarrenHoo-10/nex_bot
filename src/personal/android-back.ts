// Android's back gesture reaches the page as a `nex-android-back` event. Whatever sits on top of the page closes first,
// one layer per gesture; only then does a page go up a level.

const ESCAPE_CLOSES = '[role="menu"], .modal-backdrop [role="dialog"], .cli-supervision-panel';

/** Closes the top layer (an image or HTML preview, a dialog, a popover, a menu) and says whether there was one. */
export function closeTopLayer(): boolean {
  const lightbox = document.querySelector<HTMLButtonElement>('.image-lightbox button[aria-label="关闭图片预览"]');
  if (lightbox) { lightbox.click(); return true; }
  const preview = document.querySelector<HTMLButtonElement>('.html-preview-dialog [aria-label="关闭全屏预览"]');
  if (preview) { preview.click(); return true; }
  const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (modal) { modal.dispatchEvent(new Event("cancel", { cancelable: true })); return true; }
  const popover = document.querySelector<HTMLElement>(":popover-open");
  if (popover) { escape(popover); return true; }
  const closeModal = document.querySelector<HTMLButtonElement>('.modal-backdrop button[aria-label^="关闭"]:not(:disabled)');
  if (closeModal) { closeModal.click(); return true; }
  const layer = document.querySelector<HTMLElement>(ESCAPE_CLOSES);
  if (layer) { escape(layer); return true; }
  return false;
}

/** An Escape press on `target`: it reaches the element's own handler and then the document's. */
function escape(target: HTMLElement) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/** A view's own back step, set while it is shown: true when it closed something of its own (a search, an archive view). */
export type BackStep = { current: (() => boolean) | null };
