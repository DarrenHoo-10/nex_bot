import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";

function portalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".rk-workspace") ?? document.body;
}

/** A minimal enlarged-image view: the image floats over the transcript and
 * only one control is shown, an X at its top-right corner. When onDelete is
 * supplied the X removes the image; otherwise it closes the view. Clicking the
 * backdrop or pressing Escape closes without removing anything. */
export function ImageLightbox({ src, alt, deleteLabel = "删除图片", onClose, onDelete }: {
  src: string;
  alt: string;
  deleteLabel?: string;
  onClose: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const button = useRef<HTMLButtonElement>(null);
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
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);

  const remove = async () => {
    if (deleting) return;
    if (!onDelete) {
      onClose();
      return;
    }
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
        <button ref={button} type="button" className="image-lightbox-delete" aria-label={deleteLabel} title={deleteLabel} disabled={deleting} onClick={() => void remove()}>
          {deleting ? <Loader2 size={17}/> : <X size={19}/>}
        </button>
      </div>
      {error ? <p className="image-lightbox-error" role="alert">{error}</p> : null}
    </div>,
    portalRoot(),
  );
}
