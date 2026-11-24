// The chat-style record of a session: the newest page over HTTP, then pushes
// from the stream. Older pages load on request and keep the reader's place.
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { completedCliReplies, type CliEngine, type CliItem, type CliSessionKey } from "../../../shared/cli-agents";
import { AGENT_LABEL } from "./session-model";
import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, useBottomFollowResize } from "../../lib/bottom-follow";
import {HarnessMark} from "./tokendance/HarnessMark";
import { Languages } from "lucide-react";
import { useChineseReply } from "./use-chinese-reply";
import { AnnotatedMessage } from "./AnnotatedMessage";
import { useReview, type Note } from "./WorkbenchReview";
import { ToolActivityDisclosure } from "../vendor/rakazo/ToolActivityDisclosure";
import { cliErrorText, fetchItems, translateReply } from "./api";
import type { CliStream } from "./stream";
import { activityStats, groupItems, mergeItems, oldestId, prependItems, resetItems, toolSummary, userTurns, type ActivityItem, type Block } from "./transcript";

/** Earlier turns load on their own until this many user messages are in view. */
const MIN_TURNS_IN_VIEW = 3;
const MAX_AUTO_PAGES = 6;
/** Scrolling this close to the top loads the next older page. */
const OLDER_SCROLL_PX = 160;

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

interface CoreReply { key: CliSessionKey; id: string }

export function ReplyText({ source, supplied, local = true, core }: { source: string; supplied?: string; local?: boolean; core?: CoreReply }) {
  const [original, setOriginal] = useState(false);
  const localReply = useChineseReply(local && !core ? source : "", supplied);
  const [remoteReply, setRemoteReply] = useState<string>();
  const [remoteStatus, setRemoteStatus] = useState<"idle" | "working" | "failed">("idle");
  const [attempt, retry] = useState(0);
  const key = core?.key, itemId = core?.id;
  useEffect(() => {
    if (!key || !itemId || supplied || !/[a-z]{3,}/i.test(source)) return;
    const controller = new AbortController();
    setRemoteStatus("working");
    void translateReply(key, itemId, source, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setRemoteReply(result);
      setRemoteStatus("idle");
    }, () => {
      if (!controller.signal.aborted) setRemoteStatus("failed");
    });
    return () => controller.abort();
  }, [key, itemId, source, supplied, attempt]);
  const translation = localReply.translation ?? (core ? remoteReply : undefined);
  const status = core ? remoteStatus : localReply.status;
  const request = core ? () => retry(value => value + 1) : localReply.request;
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

function BlockView({ block, engine, translations, onEdit, byline = true, local, core }: { block: Block; engine?: CliEngine; translations?:Record<string,string>; onEdit?:(messageId:string,text:string)=>void; byline?: boolean; local: boolean; core?: CoreReply }) {
  switch (block.kind) {
    case "user":
      if(block.item.text.trim()==="[Request interrupted by user]")return <div className="cli-notice">你已中断本次请求</div>;
      return (
        <div className="cli-msg is-user" data-testid="cli-user">
          <div className="na-byline is-user"><span>你</span><time>{new Date(block.item.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div>
          <div className="cli-bubble">{block.item.text}</div>
          <div className="na-user-actions">{onEdit ? <button type="button" className="text-button na-edit-resend" aria-label="编辑并重发这条消息" title="编辑并重发" onClick={()=>onEdit(block.item.id, block.item.text)}>编辑并重发</button> : null}</div>
          {block.item.queued ? <small>排队中</small> : null}
        </div>
      );
    case "assistant":
      return (
        <div className="cli-msg is-assistant markdown" data-testid="cli-assistant">
          {byline ? <div className="na-byline"><HarnessMark agentId={engine??"claude"}/><b>{engine?AGENT_LABEL[engine]:"助手"}</b><time>{new Date(block.item.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div> : null}
          <ReplyText key={block.item.text} source={block.item.text} local={local} core={core} supplied={translations && Object.hasOwn(translations, block.item.text) ? translations[block.item.text] : undefined}/>
        </div>
      );
    case "activity":
      return <div className="cli-msg is-activity"><Activity items={block.items} /></div>;
    case "notice":
      return <div className="cli-notice" data-level={block.level} role={block.level === "error" ? "alert" : undefined}>{block.text}</div>;
  }
}

/** The agent is working on the turn: NexBot's three dots in the conversation, with what is happening under them.
 * The agent's name heads it only when nothing of this reply is shown yet. */
export function WorkingRow({ engine, label, byline, action }: { engine?: CliEngine; label: string; byline: boolean; action?: ReactNode }) {
  return (
    <div className="cli-msg is-assistant na-working" data-testid="cli-working">
      {byline ? <div className="na-byline"><HarnessMark agentId={engine ?? "claude"}/><b>{engine ? AGENT_LABEL[engine] : "助手"}</b></div> : null}
      <div className="na-working-dots" role="status" aria-label={label}><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>
      <small className="na-working-caption">{label}{action}</small>
    </div>
  );
}

/** Which assistant blocks head their reply: the first one after each user message. */
export function replyHeads(blocks: readonly Block[]): { heads: Set<string>; replying: boolean } {
  const heads = new Set<string>();
  let replying = false;
  for (const block of blocks) {
    if (block.kind === "user") replying = false;
    else if (block.kind === "assistant" && !replying) { heads.add(block.id); replying = true; }
  }
  return { heads, replying };
}

/** A message the user sent that the session's records do not hold yet. */
export function EchoMessage({ text, at }: { text: string; at: number }) {
  return (
    <div className="cli-msg is-user" data-testid="cli-user-echo">
      <div className="na-byline is-user"><span>你</span><time>{new Date(at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div>
      <div className="cli-bubble">{text}</div>
    </div>
  );
}

export const TranscriptView = memo(function TranscriptView({ stream, sessionKey,engine,notes=[],onNotes,onSide,onItems,onEdit,echo,working,active = false }: { active?:boolean; echo?:{text:string;at:number}; working?:{label:string;action?:ReactNode}; onItems?(items:CliItem[]):void; onSide?(quote:string,message:string):Promise<void>; onEdit?(messageId:string,text:string):void; engine?:CliEngine; stream: CliStream; sessionKey: CliSessionKey;notes?:Note[];onNotes?(notes:Note[]):void }) {
  const review=useReview(), details=review?.records[sessionKey];
  const [items, setItems] = useState<CliItem[]>([]);
  const [translationEnabled, setTranslationEnabled] = useState<boolean | null>();
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
      setTranslationEnabled(page.translationEnabled ?? null);
    } catch (cause) {
      if (generation.current === mine) setError(cliErrorText(cause, "记录读取失败"));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [sessionKey]);

  useEffect(() => {
    setItems([]);
    setTranslationEnabled(undefined);
    setMore(false);
    followingRef.current = true;
    anchorRef.current = null;
    void loadFirst();
    const release = stream.subscribeSession(sessionKey);
    const off = stream.on((event) => {
      if (event.type !== "message" || event.message.type !== "items" || event.message.key !== sessionKey) return;
      const message = event.message;
      if (!message.reset) { setItems((current) => mergeItems(current, message.items)); return; }
      // the newest page again (a reconnect, a rewritten file, a changed App chat): earlier pages stay
      setItems((current) => {
        const next = resetItems(current, message.items);
        if (!next.kept) setMore(message.more === true);
        return next.items;
      });
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
  }, [items, !!working]);

  useBottomFollowResize(scrollRef, listRef, followingRef, sessionKey);

  const olderBusy = useRef(false);
  const loadOlder = useCallback(async () => {
    const before = oldestId(itemsRef.current);
    const scroller = scrollRef.current;
    if (!before || !scroller || olderBusy.current) return;
    const mine = generation.current;
    olderBusy.current = true;
    setLoadingOlder(true);
    setError("");
    try {
      const page = await fetchItems(sessionKey, before);
      if (generation.current !== mine) return;
      anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      setItems((current) => prependItems(current, page.items));
      setMore(page.more);
    } catch (cause) {
      if (generation.current === mine) setError(cliErrorText(cause, "记录读取失败"));
    } finally {
      olderBusy.current = false;
      setLoadingOlder(false);
    }
  }, [sessionKey]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followingRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_FOLLOW_THRESHOLD;
    // reading upwards loads earlier records without a click
    if (more && !error && scroller.scrollTop < OLDER_SCROLL_PX) void loadOlder();
  };

  // A page is 40 items, which one busy turn can fill: earlier turns load until a few are in view.
  const autoLoads = useRef(0);
  useEffect(() => { autoLoads.current = 0; }, [sessionKey]);
  useEffect(() => {
    if (loading || loadingOlder || !more || error || autoLoads.current >= MAX_AUTO_PAGES) return;
    if (userTurns(items) >= MIN_TURNS_IN_VIEW) return;
    autoLoads.current++;
    void loadOlder();
  }, [items, more, loading, loadingOlder, error, loadOlder]);

  const translations = useMemo(() => ({ ...review?.translations, ...details?.translations }), [review?.translations, details?.translations]);
  const blocks = useMemo(() => groupItems(details?.history?.length?mergeItems(details.history,items):items), [items,details?.history]);
  const { heads, replying } = useMemo(() => replyHeads(blocks), [blocks]);
  const completed = useMemo(() => completedCliReplies(items, active), [items, active]);
  const echoShown = !!echo && !items.some((item) => item.kind === "user");
  return (
    <div className="cli-transcript" ref={scrollRef} onScroll={onScroll} data-testid="cli-transcript">
      <div className="cli-transcript-list" ref={listRef}>
        {more ? <button type="button" className="cli-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "正在读取…" : "加载更早的记录"}</button> : null}
        {blocks.map(block => {
          const complete = block.kind === "assistant" && completed.has(block.id);
          const core = translationEnabled && complete ? { key: sessionKey, id: block.id } : undefined;
          const message = <BlockView key={block.id} core={core} local={translationEnabled === null && complete} engine={engine} block={block} translations={translations} onEdit={onEdit} byline={block.kind !== "assistant" || heads.has(block.id)}/>;
          // notes persist in Core in production and in sessionStorage in the review fixture: both annotate
          return onNotes ? <AnnotatedMessage onSide={onSide} key={block.id} id={block.id} notes={notes} onNotes={onNotes}>{message}</AnnotatedMessage> : message;
        })}
        {echoShown && echo ? <EchoMessage text={echo.text} at={echo.at}/> : null}
        {working ? <WorkingRow engine={engine} label={working.label} action={working.action} byline={echoShown || !replying}/> : null}
        {loading && !items.length && !echo ? <div className="cli-empty" role="status">正在读取…</div> : null}
        {!loading && !error && !items.length && !echo ? <div className="cli-empty">暂无记录</div> : null}
        {error ? <div className="cli-notice" data-level="error" role="alert">{error}<button type="button" className="text-button" onClick={() => void loadFirst()}>重试</button></div> : null}
      </div>
    </div>
  );
});
