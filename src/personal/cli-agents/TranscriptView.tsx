// The chat-style record of a session: the newest page over HTTP, then pushes
// from the stream. Older pages load on request and keep the reader's place.
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { completedCliReplies, isInterruptRecord, unwrapPastedContent, type CliEngine, type CliItem, type CliSessionKey } from "../../../shared/cli-agents";
import { MessageImages } from "../components/MessageImages";
import { parseMessageMedia } from "../message-media";
import { AGENT_LABEL } from "./session-model";
import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, useBottomFollowResize } from "../../lib/bottom-follow";
import {HarnessMark} from "./tokendance/HarnessMark";
import { Blocks, Brain, Check, ChevronDown, ChevronRight, Copy, FilePenLine, FileText, GitBranch, Languages, LoaderCircle, Search, SquareTerminal, Wrench, X, type LucideIcon } from "lucide-react";
import { useCopyFeedback } from "../../lib/copy-text";
import { useChineseReply } from "./use-chinese-reply";
import { AnnotatedMessage } from "./AnnotatedMessage";
import { useReview, type Note } from "./WorkbenchReview";
import { cliErrorText, fetchItems, translateReply } from "./api";
import type { CliStream } from "./stream";
import { localCacheScope, queueLocalCache, readLocalCache } from "../local-content-cache";
import type { CliQueueEntry } from "./api";
import { guideTimeline, type GuideMessage, activityStats, groupItems, replyTails, mergeItems, oldestId, prependItems, resetItems, toolSummary, userTurns, type ActivityItem, type Block } from "./transcript";

type StoredTail = { marks: string[]; items: CliItem[]; translationEnabled?: boolean | null };

function saveTail(scope: string | undefined, key: string, tail: StoredTail) {
  const items: CliItem[] = [], marks: string[] = [];
  tail.items.forEach((item, index) => {
    if (item.kind === "tool" || item.kind === "thinking") return;
    items.push(item);
    marks.push(tail.marks[index]);
  });
  queueLocalCache(scope, key, { ...tail, items, marks });
}

const NO_PENDING: readonly { id: string; text: string }[] = [];
const NO_HIDDEN: ReadonlySet<string> = new Set();
type CachedTranscript = { items: CliItem[]; more: boolean; translationEnabled: boolean | null; refreshedAt: number };
// The stream belongs to one mounted, authenticated workspace generation.
const transcriptCache = new WeakMap<CliStream, Map<CliSessionKey, CachedTranscript>>();
const localTranscripts = (stream: CliStream) => {
  let cache = transcriptCache.get(stream);
  if (!cache) { cache = new Map(); transcriptCache.set(stream, cache); }
  return cache;
};

/** Leaves out messages being edited or already resent, and the "interrupted" line their resend caused. */
export function withoutHidden(blocks: readonly Block[], hidden: ReadonlySet<string>): Block[] {
  if (!hidden.size) return blocks as Block[];
  const out: Block[] = [];
  let afterHidden = false;
  for (const block of blocks) {
    if (hidden.has(block.id)) { afterHidden = true; continue; }
    const interrupted = (block.kind === "user" && isInterruptRecord(block.item.text)) || (block.kind === "notice" && block.text === "已中断");
    if (afterHidden && interrupted) continue;
    afterHidden = false;
    out.push(block);
  }
  return out;
}

/** Earlier turns load on their own until this many user messages are in view. */
const MIN_TURNS_IN_VIEW = 3;
const MAX_AUTO_PAGES = 6;
/** Scrolling this close to the top loads the next older page. */
const OLDER_SCROLL_PX = 160;

// AgentDesktop imports this page, so its message renderer is loaded lazily.
const RichText = lazy(() => import("../AgentDesktop").then((module) => ({ default: module.RichText })));

type ToolCategory = "shell" | "read" | "edit" | "search" | "mcp" | "thinking" | "other";

function toolCategory(item: ActivityItem): ToolCategory {
  if (item.kind === "thinking") return "thinking";
  const name = item.name.toLowerCase();
  if (/^(bash|shell|exec|terminal|command|run_command|device\.exec)/.test(name)) return "shell";
  if (/^(read|view|cat|ls|list|glob|file_read|read_file)/.test(name)) return "read";
  if (/^(edit|write|multiedit|patch|replace|create|edit_file|write_file)/.test(name)) return "edit";
  if (/^(grep|search|find|websearch|web_search|ripgrep)/.test(name)) return "search";
  if (/^(mcp|connector\.)/.test(name)) return "mcp";
  return "other";
}

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  shell: SquareTerminal,
  read: FileText,
  edit: FilePenLine,
  search: Search,
  mcp: Blocks,
  thinking: Brain,
  other: Wrench,
};

const CATEGORY_DONE_LABEL: Record<ToolCategory, string> = {
  shell: "运行了命令",
  read: "读取了文件",
  edit: "编辑了文件",
  search: "搜索了内容",
  mcp: "调用了工具集成",
  thinking: "思考过程",
  other: "执行了操作",
};

const CATEGORY_LIVE_LABEL: Record<ToolCategory, string> = {
  shell: "正在执行命令",
  read: "正在执行读取",
  edit: "正在执行编辑",
  search: "正在执行搜索",
  mcp: "正在执行工具集成",
  thinking: "正在执行思考",
  other: "正在执行操作",
};

function activityHeading(items: readonly ActivityItem[], live: boolean): { icon: LucideIcon; label: string } {
  const categories = [...new Set(items.map(toolCategory))];
  const primary: ToolCategory = categories.length === 1 ? categories[0] : (categories.find((c) => c !== "thinking") ?? "other");
  if (categories.length === 1) {
    return {
      icon: CATEGORY_ICON[primary],
      label: live ? CATEGORY_LIVE_LABEL[primary] : CATEGORY_DONE_LABEL[primary],
    };
  }
  return {
    icon: CATEGORY_ICON[primary],
    label: live ? `正在执行 · ${items.length} 项操作` : `执行了 ${items.length} 项操作`,
  };
}

function Activity({ items }: { items: ActivityItem[] }) {
  const stats = activityStats(items);
  const failed = items.filter((item) => item.kind === "tool" && item.status === "error").length;
  const heading = activityHeading(items, stats.live);
  const HeadIcon = heading.icon;
  return (
    <details data-testid="tool-activity" data-live={stats.live || undefined} className="na-activity">
      <summary className="na-activity-summary">
        <HeadIcon size={14} strokeWidth={1.75} className="na-activity-icon" aria-hidden="true" />
        <span className="na-activity-label">{heading.label}</span>
        {failed > 0 ? <span className="na-activity-failed">· {failed} 项失败</span> : null}
        <ChevronDown size={13} strokeWidth={1.75} className="na-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="na-activity-list cli-steps">
        {items.map((item) => {
          const category = toolCategory(item);
          const StepIcon = CATEGORY_ICON[category];
          if (item.kind === "thinking") {
            return (
              <details key={item.id} className="cli-step na-step">
                <summary>
                  <StepIcon size={13.5} strokeWidth={1.75} className="na-step-icon" aria-hidden="true" />
                  <span className="na-step-line">思考过程</span>
                  <ChevronRight size={13} className="na-step-chevron" aria-hidden="true" />
                </summary>
                <div className="na-step-card">
                  <div className="na-step-card-head">思考</div>
                  <div className="na-step-card-body">
                    <pre className="na-step-output">{item.text}</pre>
                  </div>
                </div>
              </details>
            );
          }
          const isShell = category === "shell";
          const line = toolSummary(item.input) || item.name;
          const cardTitle = isShell ? "Shell" : item.name;
          const inputText = item.input.trim();
          const outputText = item.output?.trim() ?? "";
          return (
            <details key={item.id} className="cli-step na-step" data-status={item.status}>
              <summary>
                <StepIcon size={13.5} strokeWidth={1.75} className="na-step-icon" aria-hidden="true" />
                <code className="na-step-line">{item.status === "error" && isShell ? `Command failed (${line})` : line}</code>
                <ChevronRight size={13} className="na-step-chevron" aria-hidden="true" />
              </summary>
              <div className="na-step-card">
                <div className="na-step-card-head">{cardTitle}</div>
                <div className="na-step-card-body">
                  {inputText ? <pre className="na-step-input">{isShell ? `$ ${inputText}` : inputText}</pre> : null}
                  {outputText ? <pre className="na-step-output">{outputText}</pre> : null}
                </div>
                <div className="na-step-card-foot" data-status={item.status}>
                  {item.status === "ok" ? <><Check size={12} strokeWidth={2.2} aria-hidden="true" />成功</>
                    : item.status === "error" ? <><X size={12} strokeWidth={2.2} aria-hidden="true" />失败</>
                    : <><LoaderCircle size={12} className="na-busy-icon" aria-hidden="true" />运行中</>}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}

interface CoreReply { key: CliSessionKey; id: string }

export function ReplyText({ source, supplied, local = true, core, actions, onBranch }: {
  source: string; supplied?: string; local?: boolean; core?: CoreReply; actions?: boolean; onBranch?(): void;
}) {
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
  const copied = useCopyFeedback(shown);
  const media = useMemo(() => parseMessageMedia(shown, true), [shown]);
  const text = media.images.length ? media.text : shown;
  const CopyIcon = copied.state === "copied" ? Check : copied.state === "failed" ? X : Copy;
  return <>
    <MessageImages images={media.images} fitImage/>
    {text ? <Suspense fallback={<p className="cli-plain">{text}</p>}><RichText value={text}/></Suspense> : null}
    {translation ? <button type="button" className="text-button na-original" onClick={() => setOriginal(!original)}>
      <Languages size={12}/>{original ? "查看中文" : "查看原文"}
    </button> : status !== "idle" && <button type="button" className="text-button na-original" disabled={status === "working"} onClick={request}>
      <Languages size={12}/>{status === "working" ? "正在翻译…" : status === "failed" ? "重试翻译" : "翻译成中文"}
    </button>}
    {actions && <div className="na-reply-actions">
      <button type="button" aria-label="复制" title={copied.state === "copied" ? "已复制" : copied.state === "failed" ? "复制失败" : "复制"} onClick={copied.copy}>
        <CopyIcon size={15} aria-hidden="true" />
      </button>
      {onBranch && <button type="button" aria-label="分支到新聊天" title="分支到新聊天" onClick={onBranch}>
        <GitBranch size={15} aria-hidden="true" />
      </button>}
    </div>}
  </>;
}

function BlockView({ block, engine, translations, onEdit, guideStatus, byline = true, actions = true, local, core, onBranch }: { block: Block; guideStatus?:string; engine?: CliEngine; translations?:Record<string,string>; onEdit?:(messageId:string,text:string)=>void; byline?: boolean; actions?: boolean; local: boolean; core?: CoreReply; onBranch?(): void }) {
  // onEdit is passed only for a message that may still be revised
  switch (block.kind) {
    case "user":
      if(isInterruptRecord(block.item.text))return <div className="cli-notice">你已中断本次请求</div>;
      return (
        <div className="cli-msg is-user" data-testid="cli-user">
          <UserMessageContent text={block.item.text}/>
          {onEdit ? <div className="na-user-actions"><button type="button" className="text-button na-edit-resend" aria-label="编辑并重发这条消息" title="编辑并重发" onClick={()=>onEdit(block.item.id, block.item.text)}>编辑并重发</button></div> : null}
          {guideStatus && <small>{guideStatus}</small>}
          {block.item.queued ? <small>排队中</small> : null}
        </div>
      );
    case "assistant":
      return (
        <div className="cli-msg is-assistant markdown" data-testid="cli-assistant">
          {byline ? <div className="na-byline"><HarnessMark agentId={engine??"claude"}/><b>{engine?AGENT_LABEL[engine]:"助手"}</b><time>{new Date(block.item.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div> : null}
          <ReplyText key={block.item.text} actions={actions} onBranch={onBranch} source={block.item.text} local={local} core={core} supplied={translations && Object.hasOwn(translations, block.item.text) ? translations[block.item.text] : undefined}/>
        </div>
      );
    case "activity":
      return <div className="cli-msg is-activity"><Activity items={block.items} /></div>;
    case "notice":
      return <div className="cli-notice" data-level={block.level} role={block.level === "error" ? "alert" : undefined}>{block.text}</div>;
  }
}

/** The agent is working on the turn: NexBot's three dots in the conversation; what is happening is only read out.
 * The agent's name heads it only when nothing of this reply is shown yet. */
export function WorkingRow({ engine, label, byline }: { engine?: CliEngine; label: string; byline: boolean }) {
  return (
    <div className="cli-msg is-assistant na-working" data-testid="cli-working">
      {byline ? <div className="na-byline"><HarnessMark agentId={engine ?? "claude"}/><b>{engine ? AGENT_LABEL[engine] : "助手"}</b></div> : null}
      <div className="na-working-dots" role="status" aria-label={label}><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>
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

/** How long after sending a message may still be edited and resent, while nothing answered it. */
export const EDIT_WINDOW_MS = 30_000;

/** The user messages that may still be edited: nothing of the agent follows them and they are under EDIT_WINDOW_MS old.
 * `next` is when the earliest of them stops being editable. */
export function editableMessages(blocks: readonly Block[], now: number): { ids: Set<string>; next: number | null } {
  const ids = new Set<string>();
  let next: number | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === "assistant" || block.kind === "activity") break;
    if (block.kind !== "user" || isInterruptRecord(block.item.text)) continue;
    const until = block.item.ts + EDIT_WINDOW_MS;
    if (until <= now) break;
    ids.add(block.id);
    next = next === null ? until : Math.min(next, until);
  }
  return { ids, next };
}

function UserMessageContent({ text: raw }: { text: string }) {
  const text = unwrapPastedContent(raw);
  const media = useMemo(() => parseMessageMedia(text, true), [text]);
  const caption = media.images.length ? media.text : text;
  // the pictures sit in the message's top-left corner; without words they stand on their own
  if (!caption) return <MessageImages images={media.images} fitImage/>;
  return <div className="cli-bubble" data-media={media.images.length ? true : undefined}>
    <MessageImages images={media.images} fitImage/>
    {caption}
  </div>;
}

/** A message the user sent that the session's records do not hold yet. */
export function EchoMessage({ text }: { text: string }) {
  return (
    <div className="cli-msg is-user" data-testid="cli-user-echo">
      <UserMessageContent text={text}/>
    </div>
  );
}

export const TranscriptView = memo(function TranscriptView({ stream, sessionKey,engine,notes=[],onNotes,onSide,onItems,onEdit,onBranch,echo,guides,queueEntries,pending=NO_PENDING,hidden=NO_HIDDEN,working,deliveryLabel,active = false }: { deliveryLabel?:string; guides?:readonly GuideMessage[]; queueEntries?:readonly CliQueueEntry[]; active?:boolean; hidden?:ReadonlySet<string>; echo?:{text:string;at:number}; pending?:readonly {id:string;text:string}[]; working?:{label:string}; onItems?(items:CliItem[]):void; onSide?(quote:string,message:string):Promise<void>; onEdit?(messageId:string,text:string):void; onBranch?(messageId: string): void; engine?:CliEngine; stream: CliStream; sessionKey: CliSessionKey;notes?:Note[];onNotes?(notes:Note[]):void }) {
  const review=useReview(), details=review?.records[sessionKey];
  const [items, setItems] = useState<CliItem[]>([]);
  const [translationEnabled, setTranslationEnabled] = useState<boolean | null>();
  useEffect(()=>{onItems?.(items)},[items,onItems]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const latestTranscript = useRef({ sessionKey, items, more, translationEnabled });
  latestTranscript.current = { sessionKey, items, more, translationEnabled };
  const fetchedAt = useRef(0);
  const streamResets = useRef(0);
  const refreshDeltas = useRef<CliItem[] | null>(null);
  const generation = useRef(0);
  const localTail = useRef<StoredTail | undefined>(undefined);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    const resetAtStart = streamResets.current;
    const pushed: CliItem[] = [];
    refreshDeltas.current = pushed;
    const scope = localCacheScope();
    setLoading(true);
    setError("");
    try {
      const page = await fetchItems(sessionKey);
      if (generation.current !== mine) return;
      // pushes that arrived while the page was loading stay
      if (streamResets.current === resetAtStart) {
        setItems(current => {
          const next = resetItems(current, page.items);
          if (!next.kept) setMore(page.more);
          return mergeItems(next.items, pushed, false, true);
        });
      }
      setTranslationEnabled(page.translationEnabled ?? null);
      fetchedAt.current = Date.now();
      if (localTail.current) {
        localTail.current = { ...localTail.current, translationEnabled: page.translationEnabled ?? null };
        saveTail(scope, `cli-tail:${sessionKey}`, localTail.current);
      }
    } catch (cause) {
      if (generation.current === mine) setError(cliErrorText(cause, "记录读取失败"));
    } finally {
      if (generation.current === mine) { refreshDeltas.current = null; setLoading(false); }
    }
  }, [sessionKey]);

  useEffect(() => {
    const cache = localTranscripts(stream);
    const memory = cache.get(sessionKey);
    fetchedAt.current = memory?.refreshedAt ?? 0;
    setItems(memory?.items ?? []);
    setTranslationEnabled(memory?.translationEnabled);
    setMore(memory?.more ?? false);
    setOlderError("");
    setError("");
    followingRef.current = true;
    anchorRef.current = null;
    const scope = localCacheScope(), key = `cli-tail:${sessionKey}`;
    localTail.current = undefined;
    let stopped = false, release: (() => void) | undefined, fallback: ReturnType<typeof setTimeout> | undefined;
    const open = (cached?: StoredTail) => {
      if (stopped || release) return;
      clearTimeout(fallback);
      localTail.current = cached;
      release = stream.subscribeSession(sessionKey, scope ? cached?.marks ?? [] : undefined);
      if (!cached && (!memory || Date.now() - fetchedAt.current >= 30_000)) void loadFirst();
      else if (!cached) setLoading(false);
      else {
        setTranslationEnabled(cached.translationEnabled ?? null);
        fallback = setTimeout(() => void loadFirst(), 1200);
      }
    };
    if (scope) void readLocalCache<StoredTail>(scope, key).then(open);
    else open();
    let batch: { items: CliItem[]; more?: boolean } | undefined;
    const off = stream.on((event) => {
      if (event.type === "status") batch = undefined;
      if (event.type !== "message" || event.message.type !== "items" || event.message.key !== sessionKey) return;
      const message = event.message;
      if (message.snapshot) {
        batch = undefined;
        streamResets.current++;
        clearTimeout(fallback);
        const previous = localTail.current;
        const byMark = new Map(previous?.marks.map((mark, index) => [mark, previous.items[index]]));
        const changed = new Map(message.items.map(item => [item.id, item]));
        const rebuilt = message.snapshot.map(mark => changed.get(mark.slice(65)) ?? byMark.get(mark));
        if (!rebuilt.every((item): item is CliItem => item !== undefined)) {
          void loadFirst();
          return;
        }
        const tail = { marks: message.snapshot, items: rebuilt, translationEnabled: previous?.translationEnabled };
        localTail.current = tail;
        stream.updateSessionKnown(sessionKey, tail.marks);
        saveTail(scope, key, tail);
        setLoading(false);
        setItems(current => {
          const next = resetItems(current, rebuilt);
          if (!next.kept) setMore(message.more === true);
          return next.items;
        });
        return;
      }
      if (message.reset) clearTimeout(fallback);
      if (message.reset) batch = { items: [], more: message.more };
      if (!batch) {
        refreshDeltas.current?.push(...message.items);
        setItems(current => mergeItems(current, message.items, false, true)); return;
      }
      batch.items.push(...message.items);
      if (message.continues) return;
      const page = batch;
      batch = undefined;
      streamResets.current++;
      // the newest page again (a reconnect, a rewritten file, a changed App chat): earlier pages stay
      setItems((current) => {
        const next = resetItems(current, page.items);
        if (!next.kept) setMore(page.more === true);
        return next.items;
      });
    });
    return () => {
      const last = latestTranscript.current;
      if (last.sessionKey === sessionKey && last.translationEnabled !== undefined && fetchedAt.current) {
        cache.delete(sessionKey);
        cache.set(sessionKey, { items: last.items.slice(-200), more: last.more || last.items.length > 200,
          translationEnabled: last.translationEnabled, refreshedAt: fetchedAt.current });
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
      }
      generation.current++;
      stopped = true;
      clearTimeout(fallback);
      off();
      release?.();
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
  }, [items, !!working, pending.length, guides?.length]);

  useBottomFollowResize(scrollRef, listRef, followingRef, sessionKey);

  const olderBusy = useRef(false);
  const loadOlder = useCallback(async () => {
    const before = oldestId(itemsRef.current);
    const scroller = scrollRef.current;
    if (!before || !scroller || olderBusy.current) return;
    const mine = generation.current;
    olderBusy.current = true;
    setLoadingOlder(true);
    setOlderError("");
    try {
      const page = await fetchItems(sessionKey, before);
      if (generation.current !== mine || oldestId(itemsRef.current) !== before) return;
      const shownIds = new Set(itemsRef.current.map(item => item.id));
      if (page.more && page.items.every(item => shownIds.has(item.id))) {
        setOlderError("历史游标未前进，请重试");
        return;
      }
      anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      setItems((current) => prependItems(current, page.items));
      setMore(page.more);
    } catch (cause) {
      if (generation.current === mine && oldestId(itemsRef.current) === before) {
        setOlderError(cliErrorText(cause, "更早的记录读取失败"));
      }
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
    if (!loading && more && !error && !olderError && scroller.scrollTop < OLDER_SCROLL_PX) void loadOlder();
  };

  // A page is 40 items, which one busy turn can fill: earlier turns load until a few are in view.
  const autoLoads = useRef(0);
  useEffect(() => { autoLoads.current = 0; }, [sessionKey]);
  useEffect(() => {
    if (loading || loadingOlder || !more || error || olderError || autoLoads.current >= MAX_AUTO_PAGES) return;
    if (userTurns(items) >= MIN_TURNS_IN_VIEW) return;
    autoLoads.current++;
    void loadOlder();
  }, [items, more, loading, loadingOlder, error, olderError, loadOlder]);

  const translations = useMemo(() => ({ ...review?.translations, ...details?.translations }), [review?.translations, details?.translations]);
  const blocks = useMemo(() => withoutHidden(groupItems(guideTimeline(details?.history?.length?mergeItems(details.history,items):items, guides ?? [])), hidden), [items,details?.history,hidden,guides]);
  const { heads, replying } = useMemo(() => replyHeads(blocks), [blocks]);
  const tails = useMemo(() => replyTails(blocks), [blocks]);
  const completed = useMemo(() => completedCliReplies(items, active), [items, active]);
  const echoShown = !!echo && !items.some((item) => item.kind === "user");
  // edit-and-resend: only a message nothing answered yet, and only for a short while
  const [now, setNow] = useState(() => Date.now());
  const editable = useMemo(() => onEdit ? editableMessages(blocks, now) : { ids: new Set<string>(), next: null }, [blocks, now, onEdit]);
  useEffect(() => {
    if (editable.next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, editable.next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [editable.next]);
  useEffect(() => { setNow(Date.now()); }, [items]);
  return (
    <div className="cli-transcript" ref={scrollRef} onScroll={onScroll} data-testid="cli-transcript">
      <div className="cli-transcript-list" ref={listRef}>
        {more ? <button type="button" className="cli-older" disabled={loading || loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? "正在读取…" : olderError ? "重试加载更早的记录" : "加载更早的记录"}
        </button> : null}
        {more && olderError ? <div className="cli-notice" data-level="error" role="alert">{olderError}</div> : null}
        {blocks.map(block => {
          const localOnly = block.id.startsWith("guide:") || block.id.startsWith("after-guide:");
          const complete = block.kind === "assistant" && completed.has(block.id) &&
            (!guides?.length || items.some(item => item.kind === "assistant" && item.id === block.id && item.text === block.item.text));

          const core = translationEnabled && complete ? { key: sessionKey, id: block.id } : undefined;
          const guide = block.kind === "user" ? guides?.find(row => "guide:" + row.id === block.id) : undefined;
          const status = guide && queueEntries?.find(entry => entry.id === guide.id)?.status;
          const guideStatus = status === "failed" ? "发送失败" : status === "uncertain" || guide?.uncertain ? "待确认" : undefined;
          // copy and branch: only on a finished reply's conclusion, not on what the agent wrote while working
          const conclusion = complete && tails.has(block.id);
          const message = <BlockView guideStatus={guideStatus} key={block.id} core={core} local={translationEnabled === null && complete} engine={engine} block={block} translations={translations} onEdit={!localOnly && editable.ids.has(block.id) ? onEdit : undefined} actions={conclusion} onBranch={conclusion && onBranch ? () => onBranch(block.id) : undefined} byline={block.kind !== "assistant" || heads.has(block.id)}/>;
          // notes persist in Core in production and in sessionStorage in the review fixture: both annotate
          return onNotes && !localOnly ? <AnnotatedMessage onSide={onSide} key={block.id} id={block.id} notes={notes} onNotes={onNotes}>{message}</AnnotatedMessage> : message;
        })}
        {echoShown && echo ? <EchoMessage text={echo.text}/> : null}
        {pending.map((entry) => <EchoMessage key={entry.id} text={entry.text}/>)}
        {deliveryLabel ? <small className="cli-notice" role="status">{deliveryLabel}</small> : null}
        {working ? <WorkingRow engine={engine} label={working.label} byline={echoShown || pending.length > 0 || !replying}/> : null}
        {loading && !items.length && !echo ? <div className="cli-empty" role="status">正在读取…</div> : null}
        {!loading && !error && !items.length && !echo && !pending.length ? <div className="cli-empty">暂无记录</div> : null}
        {error ? <div className="cli-notice" data-level="error" role="alert">{error}<button type="button" className="text-button" onClick={() => void loadFirst()}>重试</button></div> : null}
      </div>
    </div>
  );
});
