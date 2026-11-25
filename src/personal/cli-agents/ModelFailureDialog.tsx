// A model call that failed after the CLI's own retries: one centred notice in
// NexAgent's dialog style. The turn has already ended where it was.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";

export function ModelFailureDialog({ reason, onClose }: { reason: string; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(
    <div className="modal-backdrop na-failure-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal na-dialog na-failure" role="alertdialog" aria-modal="true" aria-labelledby="na-failure-title" aria-describedby="na-failure-reason"
        onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); if (event.key === "Escape") onClose(); } }}>
        <span className="na-failure-mark" aria-hidden="true"><CircleAlert size={22}/></span>
        <h3 id="na-failure-title">模型调用失败</h3>
        <p id="na-failure-reason">{reason}</p>
        <footer><button ref={close} type="button" className="primary" onClick={onClose}>知道了</button></footer>
      </div>
    </div>,
    document.body,
  );
}
