import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Shows `panel` (a `popover="manual"` element) next to its anchor while `open`: below it when there is room,
 * otherwise above, kept inside the window. A pointer down outside `inside()` and the panel calls `close`.
 */
export function useAnchoredPopover(open: boolean, panel: RefObject<HTMLElement | null>, anchor: () => HTMLElement | null | undefined, inside: () => readonly (Node | null | undefined)[], close: () => void, width: number | "content" = 320, align: "start" | "end" = "start", focusPanel = false): void {
  const latest = useRef({ anchor, inside, close });
  latest.current = { anchor, inside, close };
  useLayoutEffect(() => {
    const el = panel.current; if (!open || !el) return;
    el.showPopover();
    if (focusPanel) el.focus({ preventScroll: true });
    const position = () => {
      const box = latest.current.anchor()?.getBoundingClientRect(); if (!box) return;
      if (width !== "content") el.style.width = `${Math.min(width, innerWidth - 24)}px`;
      const below = innerHeight - box.bottom - 12, above = box.top - 12, down = below >= Math.min(el.scrollHeight, 420) || below >= above;
      el.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
      const left = align === "end" ? box.right - el.offsetWidth : box.left;
      el.style.left = `${Math.max(12, Math.min(left, innerWidth - el.offsetWidth - 12))}px`;
      el.style.top = `${down ? box.bottom + 6 : Math.max(8, box.top - el.offsetHeight - 6)}px`;
    };
    position(); const observer = new ResizeObserver(position); observer.observe(el);
    window.addEventListener("resize", position);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!el.contains(target) && !latest.current.inside().some((node) => node?.contains(target))) latest.current.close();
    };
    document.addEventListener("pointerdown", outside);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); document.removeEventListener("pointerdown", outside); if (el.isConnected) el.hidePopover(); };
  }, [open, panel, width, align, focusPanel]);
}
