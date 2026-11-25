import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  busy?: boolean;
  className?: string;
}

/** Unified native modal dialog with NexBot glass surface and keyboard/backdrop handling. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  busy = false,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      dialog.dataset.dark = dialog.closest<HTMLElement>("[data-dark]")?.dataset.dark ?? document.documentElement.dataset.dark ?? "0";
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
    } else if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      className={cn(
        "m-auto w-[min(440px,calc(100vw-32px))] rounded-[var(--radius-xl)] border border-[var(--glass-edge)] bg-[var(--popover)] p-6 text-[var(--foreground)] shadow-[var(--shadow-float)] backdrop-blur-xl backdrop:bg-[var(--overlay)] backdrop:backdrop-blur-[3px]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="m-0 text-[18px] font-semibold leading-snug tracking-[-0.02em] text-[var(--foreground)]">
          {title}
        </h2>
        <Button variant="icon" size="sm" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>
          <X size={16} />
        </Button>
      </div>
      {description ? (
        <p id={descId} className="mt-2.5 mb-0 text-[13px] leading-relaxed text-[var(--muted-foreground)]">
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
}

/** Unified confirmation dialog replacing browser window.confirm() and ad-hoc confirm modals. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "danger",
  busy = false,
  error,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} busy={busy}>
      {error ? (
        <p role="alert" className="mb-3 text-[12px] text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="secondary" autoFocus disabled={busy} onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} disabled={busy} onClick={() => void onConfirm()}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
