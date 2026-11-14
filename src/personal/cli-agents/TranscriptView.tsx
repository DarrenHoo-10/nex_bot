// The chat-style record of a session: the newest page over HTTP, then pushes
// from the stream. Older pages load on request and keep the reader's place.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CliItem, CliSessionKey } from "../../../shared/cli-agents";
import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, useBottomFollowResize } from "../../lib/bottom-follow";
import { ToolActivityDisclosure } from "../vendor/rakazo/ToolActivityDisclosure";
import { cliErrorText, fetchItems } from "./api";
import type { CliStream } from "./stream";
import { activityStats, groupItems, mergeItems, oldestId, prependItems, toolSummary, type ActivityItem, type Block } from "./transcript";

// AgentDesktop imports this page, so its message renderer is loaded lazily.
const RichText = lazy(() => import("../AgentDesktop").then((module) => ({ default: module.RichText })));

const TOOL_STATUS_TEXT = { running: "运行中", ok: "完成", error: "失败" } as const;

function Activity({ items }: { items: ActivityItem[] }) {
  const stats = activityStats(items);
  return (
    <ToolActivityDisclosure live={stats.live} stepCount={stats.stepCount} steps={stats.steps}>
      <div className="cli-steps">
        {items.map((item) => item.kind === "thinking" ? (
          <details key={item.id} className="cli-step">
            <summary><span className="step-dot ok" /><strong>思考</strong></summary>
            <pre>{item.text}</pre>
          </details>
        ) : (
          <details key={item.id} className="cli-step">
            <summary>
              <span className={`step-dot ${item.status === "error" ? "failed" : item.status}`} />
              <strong>{item.name}</strong>
              <code>{toolSummary(item.input)}</code>
              <small>{TOOL_STATUS_TEXT[item.status]}</small>
            </summary>
            {item.input ? <pre>{item.input}</pre> : null}
            {item.output ? <pre>{item.output}</pre> : null}
          </details>
        ))}
      </div>
    </ToolActivityDisclosure>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="cli-msg is-user" data-testid="cli-user">
          <div className="cli-bubble">{block.item.text}</div>
          {block.item.queued ? <small>排队中</small> : null}
        </div>
      );
    case "assistant":
      return (
        <div className="cli-msg is-assistant markdown" data-testid="cli-assistant">
          <Suspense fallback={<p className="cli-plain">{block.item.text}</p>}><RichText value={block.item.text} /></Suspense>
        </div>
      );
    case "activity":
      return <div className="cli-msg is-activity"><Activity items={block.items} /></div>;
    case "notice":
      return <div className="cli-notice" data-level={block.level} role={block.level === "error" ? "alert" : undefined}>{block.text}</div>;
  }
}

export function TranscriptView({ stream, sessionKey }: { stream: CliStream; sessionKey: CliSessionKey }) {
  const [items, setItems] = useState<CliItem[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const page = await fetchItems(sessionKey);
      if (generation.current !== mine) return;
      // pushes that arrived while the page was loading stay
      setItems((current) => mergeItems(current, page.items));
      setMore(page.more);
    } catch (cause) {
      if (generation.current === mine) setError(cliErrorText(cause, "记录读取失败"));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [sessionKey]);

  useEffect(() => {
    setItems([]);
    setMore(false);
    followingRef.current = true;
    anchorRef.current = null;
    void loadFirst();
    const release = stream.subscribeSession(sessionKey);
    const off = stream.on((event) => {
      if (event.type !== "message" || event.message.type !== "items" || event.message.key !== sessionKey) return;
      const message = event.message;
      setItems((current) => mergeItems(current, message.items, message.reset === true));
      if (message.reset && message.more !== undefined) setMore(message.more);
    });
    return () => {
      generation.current++;
      off();
      release();
    };
  }, [stream, sessionKey, loadFirst]);

  // after a render: keep the tail in view while following, or hold the reader's
  // place after older items were put in front
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
      return;
    }
    followBottomGrowth(scroller, followingRef.current);
  }, [items]);

  useBottomFollowResize(scrollRef, listRef, followingRef, sessionKey);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followingRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_FOLLOW_THRESHOLD;
  };

  const loadOlder = async () => {
    const before = oldestId(itemsRef.current);
    const scroller = scrollRef.current;
    if (!before || !scroller || loadingOlder) return;
    setLoadingOlder(true);
    setError("");
    try {
      const page = await fetchItems(sessionKey, before);
      anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      setItems((current) => prependItems(current, page.items));
      setMore(page.more);
    } catch (cause) {
      setError(cliErrorText(cause, "记录读取失败"));
    } finally {
      setLoadingOlder(false);
    }
  };

  const blocks = useMemo(() => groupItems(items), [items]);
  return (
    <div className="cli-transcript" ref={scrollRef} onScroll={onScroll} data-testid="cli-transcript">
      <div className="cli-transcript-list" ref={listRef}>
        {more ? <button type="button" className="cli-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "正在读取…" : "加载更早的记录"}</button> : null}
        {blocks.map((block) => <BlockView key={block.id} block={block} />)}
        {loading && !items.length ? <div className="cli-empty" role="status">正在读取…</div> : null}
        {!loading && !error && !items.length ? <div className="cli-empty">暂无记录</div> : null}
        {error ? <div className="cli-notice" data-level="error" role="alert">{error}<button type="button" className="text-button" onClick={() => void loadFirst()}>重试</button></div> : null}
      </div>
    </div>
  );
}
