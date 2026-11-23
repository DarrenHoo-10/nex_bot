import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Trash2, X } from "lucide-react";

function portalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".rk-workspace") ?? document.body;
}

export function ImageLightbox({ src, alt, deleteLabel = "删除图片", onClose, onDelete }: {
  src: string;
  alt: string;
  deleteLabel?: string;
  onClose: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  close.current = onClose;
  deletingRef.current = deleting;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!deletingRef.current) close.current();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const next = document.activeElement === button.current && !deleteButton.current?.disabled ? deleteButton.current : null;
        (next ?? button.current)?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);

  const remove = async () => {
    if (deleting || !onDelete) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "删除失败，请重试");
      setDeleting(false);
    }
  };

  return createPortal(
    <div className="image-lightbox" onMouseDown={(event) => { if (!deleting && event.target === event.currentTarget) onClose(); }}>
      <div className="image-lightbox-frame" role="dialog" aria-modal="true" aria-label={`查看图片：${alt}`}>
        <img src={src} alt={alt} draggable={false} onContextMenu={(event) => event.preventDefault()}/>
        <div className="image-lightbox-actions">
          {onDelete && <button ref={deleteButton} type="button" className="image-lightbox-delete" aria-label={deleteLabel} title={deleteLabel} disabled={deleting} onClick={() => void remove()}>
            {deleting ? <Loader2 size={17}/> : <Trash2 size={17}/>}
          </button>}
          <button ref={button} type="button" aria-label="关闭图片预览" title="关闭图片预览" onClick={onClose}><X size={19}/></button>
        </div>
      </div>
      {error ? <p className="image-lightbox-error" role="alert">{error}</p> : null}
    </div>,
    portalRoot(),
  );
}
