import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const CLAMP = 230, HEADINGS = "h1,h2,h3,h4";

/** A long reply: outline chips from its own headings, a clamped body and a toggle. */
export function DocumentCard({ children, onExpand }: { children: ReactNode; onExpand?: () => void }) {
  const root = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), bodyId = useId();
  const [open, setOpen] = useState(false), [tall, setTall] = useState(false), [outline, setOutline] = useState<string[]>([]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      setTall(el.scrollHeight > CLAMP + 8);
      const next = [...el.querySelectorAll(HEADINGS)].map((heading) => (heading.textContent ?? "").trim());
      setOutline((current) => current.length === next.length && current.every((title, index) => title === next[index]) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const expand = () => { onExpand?.(); setOpen(true); };
  const jump = (index: number) => { expand(); requestAnimationFrame(() => body.current?.querySelectorAll(HEADINGS)[index]?.scrollIntoView({ behavior: "smooth", block: "center" })); };
  const toggle = () => { if (open) { setOpen(false); requestAnimationFrame(() => root.current?.scrollIntoView({ block: "nearest" })); } else expand(); };
  return <div className="doc" ref={root} data-open={open || undefined} data-tall={tall || undefined} data-clamped={(tall && !open) || undefined}>
    {outline.some(Boolean) ? <nav className="doc-outline" aria-label="大纲">{outline.map((title, index) => title ? <button type="button" key={index} onClick={() => jump(index)}>{title}</button> : null)}</nav> : null}
    <div className="doc-body" id={bodyId} ref={body}>{children}</div>
    {tall ? <button type="button" className="doc-more" aria-expanded={open} aria-controls={bodyId} onClick={toggle}><span>{open ? "收起" : "展开全文"}</span><ChevronDown size={13}/></button> : null}
  </div>;
}
