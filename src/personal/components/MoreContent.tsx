import { useState, type ReactNode } from "react";

/** Mount the original output only when the reader opens it. */
export function MoreContent({ children }: { children: ReactNode | (() => ReactNode) }) {
  const [open, setOpen] = useState(false);
  return <div className="message-progress">
    <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "收起" : "更多内容"}</button>
    {open && (typeof children === "function" ? children() : children)}
  </div>;
}
