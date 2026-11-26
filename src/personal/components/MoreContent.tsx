import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function formatWorkDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) return undefined;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `用时 ${seconds}秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `用时 ${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `用时 ${hours}小时${rest}分钟` : `用时 ${hours}小时`;
}

/** Mount the original output only when the reader opens it. */
export function MoreContent({ children, durationMs }: { children: ReactNode | (() => ReactNode); durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const label = formatWorkDuration(durationMs) ?? "更多内容";
  return <div className="message-progress" data-open={open || undefined}>
    <button type="button" className="more-content-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{label}</span>
      <ChevronRight size={14} strokeWidth={1.6} className="more-content-chevron" aria-hidden="true" />
    </button>
    {open && <div className="message-progress-body">{typeof children === "function" ? children() : children}</div>}
  </div>;
}
