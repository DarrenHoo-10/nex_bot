import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { useAnchoredPopover } from "./anchored-popover";

interface ContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
}

export function ComposerContext({ botId, conversationId, modelKey, activityKey, connected, open, onOpenChange }: {
  botId: string; conversationId?: string; modelKey: string; activityKey: string; connected: boolean;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const scope = JSON.stringify([botId, conversationId, modelKey]);
  const [snapshot, setSnapshot] = useState<{ scope: string; value: ContextUsage }>();
  useEffect(() => {
    if (!botId || !connected) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ bot: botId });
    if (conversationId) query.set("conversationId", conversationId);
    void api<ContextUsage>(`agents/context?${query}`, undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setSnapshot({ scope, value });
    }).catch(() => {});
    return () => controller.abort();
  }, [botId, conversationId, scope, connected, activityKey, open]);
  useAnchoredPopover(open, panel, () => trigger.current, () => [trigger.current], () => onOpenChange(false), 245, "end");

  const context = connected && snapshot?.scope === scope ? snapshot.value : undefined;
  const used = context?.usedTokens, window = context?.contextWindow;
  const percent = used != null && window ? Math.min(100, used / window * 100) : 0;
  const tone = used == null || !window ? "unknown" : percent >= 85 ? "critical" : percent >= 60 ? "warning" : "normal";
  const count = (value: number | null | undefined) => value?.toLocaleString() ?? "—";
  return <>
    <button ref={trigger} className="composer-context-trigger" type="button" aria-label="上下文窗口" aria-expanded={open}
      aria-haspopup="dialog" aria-controls={open ? id : undefined} disabled={!botId}
      onClick={() => onOpenChange(!open)}
      onKeyDown={event => { if (open && event.key === "Escape") { event.stopPropagation(); onOpenChange(false); } }}>
      <span className="composer-context-ring" aria-hidden="true" data-tone={tone} style={{ "--context-fill": `${percent}%` } as CSSProperties}/>
    </button>
    {open && <div ref={panel} id={id} className="model-menu composer-context-panel" popover="manual" role="dialog" aria-label="上下文窗口">
      <div className="composer-context-label">已使用 / 上下文窗口</div>
      <div className="composer-context-usage" data-tone={tone}>
        <span><strong>{count(used)}</strong> / {count(window)} tokens</span>
        <div className="composer-context-track" aria-hidden="true"><span style={{ width: `${percent}%` }}/></div>
      </div>
    </div>}
  </>;
}
