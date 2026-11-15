// The chat-style record of a session: the newest page over HTTP, then pushes
// from the stream. Older pages load on request and keep the reader's place.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CliItem, CliSessionKey } from "../../../shared/cli-agents";
import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, useBottomFollowResize } from "../../lib/bottom-follow";
import {HarnessMark} from "./tokendance/HarnessMark";
import { Languages } from "lucide-react";
import { useChineseReply } from "./use-chinese-reply";
import { AnnotatedMessage } from "./AnnotatedMessage";
import { useReview, type Note } from "./WorkbenchReview";
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

function ReplyText({source, supplied}: { source: string; supplied?: string }) {
  const [original, setOriginal] = useState(false);
  const { translation, status, request } = useChineseReply(source, supplied);
  const shown = original ? source : translation || source;
  return <>
    <Suspense fallback={<p className="cli-plain">{shown}</p>}><RichText value={shown}/></Suspense>
    {translation ? <button type="button" className="text-button na-original" onClick={() => setOriginal(!original)}>
      <Languages size={12}/>{original ? "查看中文" : "查看原文"}
    </button> : status !== "idle" && <button type="button" className="text-button na-original" disabled={status === "working"} onClick={request}>
      <Languages size={12}/>{status === "working" ? "正在翻译…" : status === "failed" ? "重试翻译" : "翻译成中文"}
    </button>}
  </>;
}

function BlockView({ block, engine, translations }: { block: Block; engine?: "claude"|"codex"; translations?:Record<string,string> }) {
  switch (block.kind) {
    case "user":
      if(block.item.text.trim()==="[Request interrupted by user]")return <div className="cli-notice">你已中断本次请求</div>;
      return (
        <div className="cli-msg is-user" data-testid="cli-user">
          <div className="na-byline is-user"><span>你</span><time>{new Date(block.item.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div>
          <div className="cli-bubble">{block.item.text}</div>
          {block.item.queued ? <small>排队中</small> : null}
        </div>
      );
    case "assistant":
      return (
        <div className="cli-msg is-assistant markdown" data-testid="cli-assistant">
          <div className="na-byline"><HarnessMark agentId={engine??"claude"}/><b>{engine==="codex"?"Codex":"Claude Code"}</b><time>{new Date(block.item.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div>
          <ReplyText key={block.item.text} source={block.item.text} supplied={translations && Object.hasOwn(translations, block.item.text) ? translations[block.item.text] : undefined}/>
        </div>
      );
    case "activity":
      return <div className="cli-msg is-activity"><Activity items={block.items} /></div>;
    case "notice":
      return <div className="cli-notice" data-level={block.level} role={block.level === "error" ? "alert" : undefined}>{block.text}</div>;
  }
}

export function TranscriptView({ stream, sessionKey,engine,notes=[],onNotes,onSide,onItems }: { onItems?(items:CliItem[]):void; onSide?(quote:string,message:string):Promise<void>; engine?:"claude"|"codex"; stream: CliStream; sessionKey: CliSessionKey;notes?:Note[];onNotes?(notes:Note[]):void }) {
  const review=useReview(), details=review?.records[sessionKey];
  const [items, setItems] = useState<CliItem[]>([]);
  useEffect(()=>{onItems?.(items)},[items,onItems]);
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

  const translations = useMemo(() => ({ ...review?.translations, ...details?.translations }), [review?.translations, details?.translations]);
  const blocks = useMemo(() => groupItems(details?.history?.length?mergeItems(details.history,items):items), [items,details?.history]);
  return (
    <div className="cli-transcript" ref={scrollRef} onScroll={onScroll} data-testid="cli-transcript">
      <div className="cli-transcript-list" ref={listRef}>
        {more ? <button type="button" className="cli-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "正在读取…" : "加载更早的记录"}</button> : null}
        {blocks.map(block => {
          const message = <BlockView key={block.id} engine={engine} block={block} translations={translations}/>;
          return review && onNotes ? <AnnotatedMessage onSide={onSide} key={block.id} id={block.id} notes={notes} onNotes={onNotes}>{message}</AnnotatedMessage> : message;
        })}
        {loading && !items.length ? <div className="cli-empty" role="status">正在读取…</div> : null}
        {!loading && !error && !items.length ? <div className="cli-empty">暂无记录</div> : null}
        {error ? <div className="cli-notice" data-level="error" role="alert">{error}<button type="button" className="text-button" onClick={() => void loadFirst()}>重试</button></div> : null}
      </div>
    </div>
  );
}
