import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Download, ImageOff, Loader2 } from "lucide-react";
import { desktop } from "../api";
import { imageMenuPosition, type MessageImage } from "../message-media";
import { ImageLightbox } from "./ImageLightbox";

const MENU_WIDTH = 176;
const MENU_HEIGHT = 52;

function portalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".rk-workspace") ?? document.body;
}

async function downloadImage(image: MessageImage): Promise<void> {
  if (desktop?.downloadAttachment) {
    await desktop.downloadAttachment(image.url, image.name);
    return;
  }
  const link = document.createElement("a");
  link.href = image.url;
  link.download = image.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Android WebView intercepts authenticated attachment previews, so every
 * client can use the same same-origin `?preview=1` URL. */
function useMessageImage(image: MessageImage) {
  const [source, setSource] = useState(image.previewUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSource(image.previewUrl);
    setFailed(false);
  }, [image.previewUrl]);

  return { source, failed, setFailed };
}

function MessageImageTile({ image, onDelete }: { image: MessageImage; onDelete?: (image: MessageImage) => Promise<void> }) {
  const { source, failed, setFailed } = useMessageImage(image);
  const tile = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const longPress = useRef<{ timer: number; x: number; y: number } | undefined>(undefined);
  const suppressClick = useRef(0);
  const menuGuard = useRef(0);
  const noticeTimer = useRef<number | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [viewer, setViewer] = useState(false);
  const [notice, setNotice] = useState("");
  const root = portalRoot();

  useEffect(() => {
    const clear = () => {
      if (longPress.current) {
        window.clearTimeout(longPress.current.timer);
        longPress.current = undefined;
      }
    };
    clear();
    return clear;
  }, [image.id]);

  useEffect(() => {
    if (!notice) return;
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, [notice]);

  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenu(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(undefined);
      tile.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const openMenu = (x: number, y: number, guard = false) => {
    if (guard || menuGuard.current > Date.now()) menuGuard.current = Date.now() + 450;
    setMenu({ x, y });
  };
  const openViewer = () => {
    setMenu(undefined);
    if (!failed && source) setViewer(true);
  };
  const closeViewer = () => setViewer(false);
  const startNotice = (value: string) => setNotice(value);

  const download = async () => {
    setMenu(undefined);
    try {
      await downloadImage(image);
    } catch {
      startNotice("下载失败，请重试");
    }
  };

  const clearLongPress = () => {
    if (!longPress.current) return;
    window.clearTimeout(longPress.current.timer);
    longPress.current = undefined;
  };
  const pointerUp = () => {
    // A long press can make a menu button appear under the finger; the release
    // still produces one synthetic click. Keep that click from acting.
    if (suppressClick.current > Date.now()) menuGuard.current = Date.now() + 600;
    clearLongPress();
  };
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    clearLongPress();
    longPress.current = {
      timer: window.setTimeout(() => {
        longPress.current = undefined;
        suppressClick.current = Date.now() + 900;
        openMenu(event.clientX, event.clientY, true);
      }, 480),
      x: event.clientX,
      y: event.clientY,
    };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = longPress.current;
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 10) return;
    clearLongPress();
  };
  const position = menu ? imageMenuPosition(menu.x, menu.y, MENU_WIDTH, MENU_HEIGHT, window.innerWidth, window.innerHeight) : undefined;

  return <>
    <button
      ref={tile}
      type="button"
      className={`message-image ${source ? "is-loaded" : ""} ${failed ? "is-failed" : ""}`}
      aria-label={failed ? `图片无法显示：${image.name}` : source ? `查看图片 ${image.name}` : `正在加载图片 ${image.name}`}
      aria-busy={!source && !failed ? true : undefined}
      title={failed ? image.name : "查看图片"}
      onClick={() => {
        if (Date.now() < suppressClick.current) return;
        openViewer();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(box.right - 8, box.top + 8);
      }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onDragStart={(event) => event.preventDefault()}
    >
      {failed ? <span className="message-image-failed"><ImageOff size={20}/><span>{image.name}</span></span>
        : source ? <img src={source} alt={image.alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)}/>
          : <span className="message-image-loading" role="status" aria-label="正在加载图片"><Loader2 size={18}/></span>}
    </button>

    {menu && position ? createPortal(
      <div ref={menuRef} className="image-context-menu" role="menu" aria-label="图片操作" style={{ left: position.left, top: position.top }} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" onClick={() => { if (Date.now() >= menuGuard.current) void download(); }}><Download size={15}/>下载图片</button>
      </div>, root) : null}

    {viewer && source ? <ImageLightbox src={source} alt={image.alt} deleteLabel="删除图片" onClose={closeViewer} onDelete={onDelete ? () => onDelete(image) : undefined}/> : null}

    {notice ? createPortal(<div className="image-notice" role="status" aria-live="polite">{notice}</div>, root) : null}
  </>;
}

export function MessageImages({ images, onDelete }: { images: readonly MessageImage[]; onDelete?: (image: MessageImage) => Promise<void> }) {
  if (!images.length) return null;
  return <div className="message-media">{images.map((image) => <MessageImageTile key={image.id} image={image} onDelete={onDelete}/>)}</div>;
}
