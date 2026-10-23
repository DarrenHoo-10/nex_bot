import { universalImageActions } from '../../shared/personal-capabilities';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "../lib/bottom-follow";
import Markdown, { type ExtraProps } from "react-markdown";
import type { ComponentProps } from "react";
import { ChatChart } from "./components/ChatChart";
import { HtmlPreview } from "./components/HtmlPreview";
import { htmlPreviewParts } from "../../shared/html-preview";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { rehypeStaticHTML } from "./static-html";
import { ArrowUp, AtSign, Check, ChevronDown, CircleAlert, Clock, Copy, CornerUpLeft, FileText, Image as ImageIcon, Info, Loader2, Pin, Play, Plus, PanelLeft, Share2, Shield, Sparkles, Square, X, Zap } from "lucide-react";
import { api, desktop, listModels, statuses, str, taskPhrase, toolLabels, type ClientUpdateState, type PreviewItem, type RecordRow, type State, type ToolStep } from "./api";
import { useAccount } from "./auth";
import { lookOf } from "./characters";
import { Confirm, Editor, ModelSettings, SettingsPage, type SettingsCategory } from "./panels";
import { AvatarPicker } from "./components/AvatarPicker";
import { AgentAvatar as Avatar } from "./components/AgentAvatar";
import { ContactSidebar } from "./components/ContactSidebar";
import type { ConversationMatch } from "./components/ConversationSearch";
import { ToolActivityDisclosure } from "./vendor/rakazo/ToolActivityDisclosure";
import { companionState, companionLabels, type CompanionState } from "./avatars/appearance";
import { BrandMark } from "./components/BrandMark";
import { ComposerControls } from "./components/ComposerControls";
import { MessageImages } from "./components/MessageImages";
import { ImageLightbox } from "./components/ImageLightbox";
import { isImageFileName, parseMessageMedia, type MessageImage } from "./message-media";
import { ModelPicker } from "./components/ModelPicker";
import { BotIdentity } from "./components/BotIdentity";
import { copyText as writeCopyText } from "../lib/copy-text";
import { imageFilesFromClipboard, optimisticOutgoing, withPendingOptimistic } from "./transcript-session";

const terminal = ["succeeded", "failed", "cancelled", "rejected"];
const formatTime = (value: RecordRow[string]) => value ? new Date(Number(value)).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const formatShortTime = (value: RecordRow[string]) => {
  if (!value) return "";
  const date = new Date(Number(value)), now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};
const formatDay = (value: RecordRow[string]) => {
  if (!value) return "";
  const date = new Date(Number(value)), now = new Date();
  if (date.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
};

function AgentPolicyEditor({ bot, close, save }: { bot: RecordRow; close: () => void; save: (tools: string[]) => Promise<unknown> }) {
  const [tools, setTools] = useState<string[]>(JSON.parse(str(bot.policy_json) || "{}").tools ?? []);
  const labels: Record<string, string> = { "image.models": "查看生图模型", "image.generate": "按需生成图片", "memory.search": "检索自身与共享记忆", "memory.reflect": "综合记忆并引用来源", "memory.read": "读取自身与共享记忆", "memory.write": "维护自身私有记忆", "memory.delete": "撤回自身私有记忆", "memory.forget": "彻底遗忘相关原文与副本", "routine.list": "查看自己的计划", "routine.save": "安排或修改自己的计划", "routine.toggle": "暂停或恢复自己的计划", "routine.run": "立即运行自己的计划", "agent.directory": "读取 Agent 公开目录", "agent.delegate": "联系同伴", "agent.create": "按指示招募新同伴", "agent.update": "按指示更新同伴资料", "device.list": "查看已授权设备目录", "device.read": "读取已授权设备文件", "device.exec": "执行设备终端命令", "device.inventory": "识别设备与在线状态", "device.info": "读取设备系统信息", "device.computer": "使用获准的电脑窗口", "connector.list": "查看已授权连接器", "connector.tools": "查看连接器工具", "connector.call": "调用连接器工具", "attachment.read": "读取对话附件", "skill.list": "查看通用技能目录", "skill.read": "阅读通用技能说明" };
  return <><div className="modal-heading"><h2>{bot.name} 的工具权限</h2><button aria-label="关闭" onClick={close}><X size={18}/></button></div><form onSubmit={(event) => { event.preventDefault(); void save(tools); }}><div className="policy-grid">{Object.entries(labels).map(([action, label]) => <label className="check-field" key={action}><input type="checkbox" checked={universalImageActions.some(tool => tool === action) || tools.includes(action)} disabled={universalImageActions.some(tool => tool === action)} onChange={(event) => setTools((current) => event.target.checked ? [...current, action] : current.filter((tool) => tool !== action))}/>{label}</label>)}</div><div className="actions"><button className="primary">保存</button><button type="button" onClick={close}>取消</button></div></form></>;
}

const filePathPattern = /^(?:[\w.-]+[\\/])*[\w.-]+\.(?:md|txt|json|csv|yaml|yml|ts|tsx|js|jsx|mjs|py|sql|log|html|css|sh|ps1|toml|xml)$/i;
function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const code = node?.children.length === 1 ? node.children[0] : undefined;
  if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-chart')) {
    return <ChatChart source={code.children.map(child => child.type === 'text' ? child.value : '').join('')}/>;
  }
  return <pre {...props}>{children}</pre>;
}
const FilePreviewContext = createContext<((path: string) => void) | undefined>(undefined);
const imageName = /\.(?:png|jpe?g|webp|gif)$/i;
/** Images are always served by Core; clients never receive storage URLs. */
function AttachmentImage({ id, alt }: { id: string; alt: string }) {
  return <img className="generated-chat-image" src={`/api/attachments/${id}?preview=1`} alt={alt} loading="lazy"/>;
}
function MarkdownImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const id = typeof src === "string" ? /^\/api\/attachments\/([a-zA-Z0-9-]+)$/.exec(src)?.[1] : undefined;
  return id ? <AttachmentImage id={id} alt={alt ?? "生成图片"}/> : <span>{alt ?? "图片"}</span>;
}
function MarkdownLink({ href, children }: ComponentProps<'a'> & ExtraProps) {
  const attachment = href ? /^\/api\/attachments\/([a-zA-Z0-9-]+)$/.exec(href)?.[1] : undefined, label = String(children ?? "");
  const image = attachment && imageName.test(label) ? <AttachmentImage id={attachment} alt={label}/> : undefined;
  return <>{image}<a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className={href?.startsWith("/api/attachments/") ? "file-chip" : undefined} download={href?.startsWith("/api/attachments/") || undefined} onClick={(e) => {
    if (href?.startsWith("/api/attachments/")) {
      if (desktop?.downloadAttachment) { e.preventDefault(); void desktop.downloadAttachment(href, e.currentTarget.textContent || "附件").catch(() => window.dispatchEvent(new CustomEvent("nex-download-error"))); }
      return;
    }
    if (href && /^https?:\/\//.test(href) && desktop?.openExternal) { e.preventDefault(); void desktop.openExternal(href); }
  }}>{children}</a></>;
}
function MarkdownCode({ className, children }: ComponentProps<'code'> & ExtraProps) {
  const onPreviewFile = useContext(FilePreviewContext), raw = String(children ?? "").trim();
  if (!className && onPreviewFile && filePathPattern.test(raw)) return <button type="button" className="file-chip" onClick={() => onPreviewFile(raw)} title={`在右侧面板预览 ${raw}`}><FileText size={11}/><span>{raw}</span></button>;
  return <code className={className}>{children}</code>;
}
// Stable component types preserve focused links/buttons across conversation
// refreshes. Context supplies the latest preview callback without remounting.
const markdownComponents = { pre: MarkdownPre, img: MarkdownImage, a: MarkdownLink, code: MarkdownCode };
export function RichText({ value, onPreviewFile, pending = false }: { value: string; onPreviewFile?: (path: string) => void; pending?: boolean }) {
  return <div className="markdown"><FilePreviewContext.Provider value={onPreviewFile}>{htmlPreviewParts(value).map((part, index) => part.kind === 'preview'
    ? <HtmlPreview key={index} source={part.source} complete={part.complete} pending={pending}/>
    : <Markdown key={index} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeStaticHTML]} components={markdownComponents}>{part.source}</Markdown>)}</FilePreviewContext.Provider></div>;
}

export function AgentDesktop() {
  const { status: accountStatus, logout } = useAccount();
  const [state, setState] = useState<State>(), [page, setPage] = useState("agent");
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("account");
  const openSettings = (category: SettingsCategory = "account") => { setSettingsCategory(category); setPage("settings"); setSidebarOpen(false); };
  const [botId, setBotId] = useState(localStorage.getItem("nexbot.selectedAgent") ?? "");
  const [pinned, setPinned] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("nexbot.pinnedAgents") || "[]") as string[]; } catch { return []; } });
  const [dark, setDark] = useState(() => localStorage.getItem("nexbot.dark") === "1");
  const [sidebarOpen, setSidebarOpen] = useState(desktop?.platform === "android" && window.innerWidth <= 720);
  type Attachment = { id: string; name: string; size: number; mime?: string; previewUrl?: string };
  type PendingUpload = { key: string; file: File; error?: string; controller: AbortController };
  const [attachments, setAttachments] = useState<Attachment[]>([]), [pending, setPending] = useState<PendingUpload[]>([]);
  const [draftPreview, setDraftPreview] = useState<{ src: string; label: string }>();
  const attachmentDrafts = useRef(new Map<string, Attachment[]>()), pendingDrafts = useRef(new Map<string, PendingUpload[]>()), fileInput = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<(files: FileList | readonly File[] | null) => Promise<void>>(async () => {});
  const uploading = pending.length > 0;
  const setFiles = (target: string, files: Attachment[]) => {
    attachmentDrafts.current.set(target, files);
    if (selected.current === target) setAttachments(files);
  };
  const setPendingFiles = (target: string, files: PendingUpload[]) => {
    pendingDrafts.current.set(target, files);
    if (selected.current === target) setPending(files);
  };
  const readFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
  const uploadOne = async (target: string, item: PendingUpload) => {
    try {
      const data = await readFile(item.file);
      if (item.controller.signal.aborted) return;
      const uploaded = await api<Attachment>("attachments", { botId: target, name: item.file.name.trim() || "截图.png", data });
      if (item.controller.signal.aborted) return;
      setPendingFiles(target, (pendingDrafts.current.get(target) ?? []).filter((entry) => entry.key !== item.key));
      const mime = item.file.type || uploaded.mime || "";
      const previewUrl = mime.startsWith("image/") ? `data:${mime};base64,${data}` : undefined;
      setFiles(target, [...(attachmentDrafts.current.get(target) ?? []), { ...uploaded, mime: uploaded.mime || item.file.type, previewUrl }]);
    } catch (error) {
      if (item.controller.signal.aborted) return;
      setPendingFiles(target, (pendingDrafts.current.get(target) ?? []).map((entry) => entry.key === item.key ? { ...entry, error: error instanceof Error ? error.message : "上传失败，请重试" } : entry));
    }
  };
  const upload = async (files: FileList | readonly File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    const target = botId, current = attachmentDrafts.current.get(target) ?? [], waiting = pendingDrafts.current.get(target) ?? [];
    if (current.length + waiting.length + list.length > 5) { setError("最多添加 5 个附件"); if (fileInput.current) fileInput.current.value = ""; return; }
    if (list.some((file) => !file.size || file.size > 5 * 1024 * 1024)) { setError("请选择 5 MB 以内的非空文件"); if (fileInput.current) fileInput.current.value = ""; return; }
    setError("");
    const items: PendingUpload[] = list.map((file) => ({ key: crypto.randomUUID(), file, controller: new AbortController() }));
    setPendingFiles(target, [...waiting, ...items]);
    await Promise.all(items.map((item) => uploadOne(target, item)));
    if (fileInput.current) fileInput.current.value = "";
  };
  uploadRef.current = upload;
  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void upload(files);
  };
  const retryUpload = (item: PendingUpload) => {
    const controller = new AbortController();
    setPendingFiles(botId, (pendingDrafts.current.get(botId) ?? []).map((entry) => entry.key === item.key ? { ...entry, error: undefined, controller } : entry));
    void uploadOne(botId, { ...item, controller, error: undefined });
  };
  const removePending = (item: PendingUpload) => {
    item.controller.abort();
    setPendingFiles(botId, (pendingDrafts.current.get(botId) ?? []).filter((entry) => entry.key !== item.key));
  };
  const removeAttachment = (file: Attachment) => setFiles(botId, (attachmentDrafts.current.get(botId) ?? []).filter((entry) => entry.id !== file.id));
  const removeDraftImage = (src: string) => {
    const uploaded = (attachmentDrafts.current.get(botId) ?? []).find((file) => file.previewUrl === src);
    if (uploaded) removeAttachment(uploaded);
  };
  useEffect(() => () => {
    for (const list of pendingDrafts.current.values()) for (const item of list) item.controller.abort();
  }, []);
  const [lookRevision, setLookRevision] = useState(0);
  const [motion] = useState(() => localStorage.getItem("nexbot.motion") !== "0");
  const [settledState, setSettledState] = useState<CompanionState>("idle");
  const previousTask = useRef<{ botId: string; taskId: string } | undefined>(undefined);
  const [messages, setMessages] = useState<RecordRow[]>([]), [streaming, setStreaming] = useState<Array<{ taskId: string; text: string }>>([]);
  const [draft, setDraft] = useState(""), [search, setSearch] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [sendingBotId, setSendingBotId] = useState<string>();
  const [connected, setConnected] = useState(true), [detail, setDetail] = useState(() => window.innerWidth > 1040), [tab, setTab] = useState("profile"), [dialog, setDialog] = useState<ReactNode>(null);
  const imeEndedAt = useRef(0);
  const [modelChooserOpen, setModelChooserOpen] = useState(false);
  const [quote, setQuote] = useState<{ author: string; text: string }>(), [copiedId, setCopiedId] = useState(""), [exported, setExported] = useState(false);
  const [showScrollPill, setShowScrollPill] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState(""), [atIndex, setAtIndex] = useState(0), [atDismissed, setAtDismissed] = useState(false), [preview, setPreview] = useState<PreviewItem>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [focusedMessage,setFocusedMessage]=useState("");
  const historyTarget=useRef<{botId:string;id:string} | undefined>(undefined),scrolledTarget=useRef("");
  const selected = useRef(botId), pageRef = useRef(page), scroll = useRef<HTMLDivElement>(null), transcriptInner = useRef<HTMLDivElement>(null), composerRef = useRef<HTMLTextAreaElement>(null), serial = useRef(0);
  const previousScrollTop = useRef(0), touchY = useRef(0), feedRetry = useRef(false), loadedBot = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (desktop?.platform !== "android") return;
    const back = () => {
      const preview = document.querySelector<HTMLButtonElement>('.html-preview-fullscreen [aria-label="退出全屏"]');
      if (preview) { preview.click(); return; }
      const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (modal) { modal.dispatchEvent(new Event("cancel", { cancelable: true })); return; }
      const popover = document.querySelector<HTMLElement>(":popover-open");
      if (popover) { popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return; }
      const closeModal = document.querySelector<HTMLButtonElement>('.modal-backdrop button[aria-label^="关闭"]:not(:disabled)');
      if (closeModal) { closeModal.click(); return; }
      if (dialog) { setDialog(null); return; }
      if (detail) { setDetail(false); return; }
      if (page !== "agent") { setPage("agent"); return; }
      if (!sidebarOpen) { setSidebarOpen(true); return; }
      void desktop?.minimize?.();
    };
    const select = (event: Event) => { historyTarget.current=undefined;setFocusedMessage("");loaded.current=undefined;setBotId(String((event as CustomEvent).detail)); setPage("agent"); setSidebarOpen(false); };
    const downloadError = () => setError("附件下载失败，请重试");
    window.addEventListener("nex-android-back", back);
    window.addEventListener("nex-android-agent", select);
    window.addEventListener("nex-download-error", downloadError);
    return () => {
      window.removeEventListener("nex-android-back", back);
      window.removeEventListener("nex-android-agent", select);
      window.removeEventListener("nex-download-error", downloadError);
    };
  }, [dialog, detail, page, sidebarOpen]);
  const stickToBottom = useRef(true), memoryVersions = useRef(new Map<string, string>()), messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => { void desktop?.workspaceReady?.(); }, []);
  const [update, setUpdate] = useState<ClientUpdateState>();
  useEffect(() => {
    void desktop?.updateState?.().then(setUpdate).catch(() => {});
    return desktop?.onUpdateState?.(setUpdate) ?? undefined;
  }, []);
  useEffect(() => desktop?.onClipboardImage?.((image) => {
    const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array();
    if (!bytes.byteLength || !image.type.startsWith("image/")) return;
    const blob = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(blob).set(bytes);
    void uploadRef.current([new File([blob], image.name.trim() || "截图.png", { type: image.type })]);
  }), []);
  const loaded = useRef<{ botId: string; messages: RecordRow[]; sync: State["sync"] } | undefined>(undefined);
  const offline = useCallback(() => { ++serial.current; loaded.current = undefined; setConnected(false); setMessages([]); setStreaming([]); setSendingBotId(undefined); setState(undefined); setDialog(null); setError("Core 连接中断，正在重新同步…"); }, []);
  const drafts = useRef(new Map<string, string>()), readPositions = useRef(new Map<string, number>()), retry = useRef<{ botId: string; text: string; id: string } | undefined>(undefined);
  selected.current = botId; pageRef.current = page;

  useEffect(() => {
    document.documentElement.dataset.dark = dark ? "1" : "0";
    localStorage.setItem("nexbot.dark", dark ? "1" : "0");
  }, [dark]);

  const reload = useCallback(async () => {
    const request = ++serial.current, current = selected.current;
    type Feed = { messages: RecordRow[]; streaming: Array<{ taskId: string; text: string }>; sync: State["sync"]; hasMore: boolean };
    const target=historyTarget.current?.botId===current?historyTarget.current:undefined;
    const base = `agents/messages?bot=${encodeURIComponent(current)}${target?`&around=${encodeURIComponent(target.id)}`:""}`;
    // Over a slow link every round trip is visible, so the first page of messages is requested together with the state
    // and checked against the state's sync identity afterwards.
    const guess = !target && loaded.current?.botId === current ? loaded.current : undefined;
    const early = current ? api<Feed>(guess?.messages.length ? `${base}&after=${guess.messages.at(-1)!.seq}` : base) : undefined;
    early?.catch(() => undefined);
    const next = await api<State>("state");
    if (request !== serial.current) return;
    if (memoryVersions.current.size > 0) {
      const updated = next.memories.find((m) => (m.scope === "workspace" || m.bot_id === current) && memoryVersions.current.get(str(m.id)) !== `${m.version}:${m.updated_at}`);
      if (updated) setMemoryNotice(str(updated.title));
    }
    memoryVersions.current = new Map(next.memories.map((m) => [str(m.id), `${m.version}:${m.updated_at}`]));
    if (current && !next.bots.some((bot) => bot.id === current)) { setState(next); setBotId(str(next.bots[0]?.id)); setMessages([]); setStreaming([]); return; }
    if (current) {
      setState(next); setConnected(true);
      const cached = guess;
      const same = cached?.botId === current && cached.sync.privacyEpoch === next.sync.privacyEpoch && cached.sync.coreId === next.sync.coreId && cached.sync.bootId === next.sync.bootId;
      let history = same ? cached.messages : [];
      let feed: Feed;
      try { feed = await (same || !guess?.messages.length ? early! : api<Feed>(base)); }
      catch (failure) {
        if (request !== serial.current || selected.current !== current) return;
        if (!target || !(failure instanceof Error) || failure.message !== '该消息已不存在或已遗忘') throw failure;
        historyTarget.current=undefined;scrolledTarget.current='';setFocusedMessage('');loaded.current=undefined;stickToBottom.current=true;
        feed=await api<Feed>(`agents/messages?bot=${encodeURIComponent(current)}`);
      }
      while (true) {
        if (request !== serial.current || selected.current !== current) return;
        if (feed.sync.privacyEpoch !== next.sync.privacyEpoch || feed.sync.bootId !== next.sync.bootId) {
          const retry = !feedRetry.current;
          feedRetry.current = true;
          loaded.current = undefined;
          if (retry) setTimeout(() => void reload().catch((error: unknown) => { setError(error instanceof Error ? error.message : "操作失败"); setHistoryLoading(false); }), 0);
          return;
        }
        history = [...history, ...feed.messages];
        if (!feed.hasMore) break;
        feed = await api<Feed>(`${base}&after=${history.at(-1)!.seq}`);
      }
      if (request !== serial.current || selected.current !== current) return;
      loaded.current = { botId: current, messages: history, sync: feed.sync };
      feedRetry.current = false;
      setMessages((shown) => withPendingOptimistic(history, shown));
      setStreaming(feed.streaming.filter((s) => s.text));
      setHistoryLoading(false);
      const through = Number(history.at(-1)?.seq ?? 0);
      if (!target && pageRef.current === "agent" && document.hasFocus() && through > (readPositions.current.get(current) ?? 0)) {
        readPositions.current.set(current, through);
        void api("agents/read", { botId: current, seq: through }).catch(() => { if (readPositions.current.get(current) === through) readPositions.current.delete(current); });
      }
    }
    if (request === serial.current) { setState(next); setConnected(true); setError(""); setHistoryLoading(false); }
  }, [offline]);
  useEffect(() => {
    // A remembered Agent is loaded by the selection effect below; reloading here too would only be superseded.
    if (!selected.current) void reload().catch((e: Error) => setError(e.message));
    const events = new EventSource("/api/events"); let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void reload().catch((error: unknown) => { setError(error instanceof Error ? error.message : "操作失败"); setHistoryLoading(false); }); }, 150); };
    const change = (event: MessageEvent) => {
      const value = JSON.parse(event.data) as State["sync"] & { reset?: boolean };
      // A reconnect can report reset. Drop the incremental cursor and refetch,
      // but leave the rows on screen until the next page arrives.
      if (value.reset || (loaded.current && (loaded.current.sync.privacyEpoch !== value.privacyEpoch || loaded.current.sync.bootId !== value.bootId))) loaded.current = undefined;
      refresh();
    };
    const expired = () => { offline(); events.close(); setError("此设备的登录已过期或被撤销，请重新连接。"); };
    events.addEventListener("change", change as EventListener); events.addEventListener("revoked", () => window.dispatchEvent(new Event("nex-session-expired"))); events.onerror = () => refresh();
    window.addEventListener("nex-session-expired", expired);
    window.addEventListener("focus", refresh);
    const interval = setInterval(refresh, 10_000);
    return () => { clearTimeout(timer); clearInterval(interval); events.close(); window.removeEventListener("focus", refresh); window.removeEventListener("nex-session-expired", expired); };
  }, [reload, offline]);
  useEffect(() => { if (state && !state.bots.some((b) => b.id === botId)) setBotId(str(state.bots[0]?.id)); }, [state, botId]);
  useEffect(() => {
    const switched = loadedBot.current !== botId;
    loadedBot.current = botId;
    if (switched) {
      stickToBottom.current = !historyTarget.current;
      setShowScrollPill(false);
      setQuote(undefined);
      setMemoryNotice("");
      setPreview(undefined);
      setMessages([]);
      setStreaming([]);
      setDraft(drafts.current.get(botId) ?? "");
      setAttachments(attachmentDrafts.current.get(botId) ?? []);
      setPending(pendingDrafts.current.get(botId) ?? []);
      setDraftPreview(undefined);
    }
    if (botId) {
      if (switched) setHistoryLoading(true);
      localStorage.setItem("nexbot.selectedAgent", botId);
      void reload().catch((e: Error) => { setError(e.message); setHistoryLoading(false); });
    }
  }, [botId, reload]);
  const openFilePreview = (targetPath: string) => { void api<PreviewItem>(`preview?path=${encodeURIComponent(targetPath)}`).then((item) => { setPreview(item); setTab("profile"); setDetail(true); }).catch((e: Error) => setError(e.message)); };
  const openStepPreview = (step: ToolStep) => { if (step.tool_name === "device.read" && step.summary) { openFilePreview(step.summary); return; } void api<PreviewItem>(`preview?callId=${encodeURIComponent(step.id)}`).then((item) => { setPreview(item); setTab("profile"); setDetail(true); }).catch(() => { setPreview({ kind: "tool", id: step.id, title: toolLabels[step.tool_name] ?? step.tool_name, status: step.status, content: step.preview || "暂无输出内容", createdAt: step.created_at }); setTab("profile"); setDetail(true); }); };
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  const changeDraft = (value: string) => { setDraft(value); drafts.current.set(botId, value); setAtDismissed(false); setAtIndex(0); };
  const togglePin = (id: string) => setPinned((current) => { const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]; localStorage.setItem("nexbot.pinnedAgents", JSON.stringify(next)); return next; });
  const copyText = async (id: string, value: string) => { if (await writeCopyText(value) !== "copied") return; setCopiedId(id); setTimeout(() => setCopiedId((current) => current === id ? "" : current), 1800); };
  const deleteMessageImage = async (messageId: string, image: MessageImage) => {
    await api("agents/messages/image/delete", { botId, messageId, attachmentId: image.id });
    loaded.current = undefined;
    await reload();
  };
  const send = (event: FormEvent) => {
    event.preventDefault(); const raw = draft.trim(), target = botId; if ((!raw && !attachments.length) || busy || uploading || !state?.bots.some((agent) => agent.id === target)) return;
    const prefix = quote ? `> ${quote.author}：${quote.text.replace(/\s+/g, " ").slice(0, 140)}\n\n` : "";
    const content = prefix + raw, attachmentIds = attachments.map((file) => file.id), requestKey = content + JSON.stringify(attachmentIds);
    if (!retry.current || retry.current.botId !== target || retry.current.text !== requestKey) retry.current = { botId: target, text: requestKey, id: crypto.randomUUID() };
    const clientId = retry.current.id;
    if (historyTarget.current) { historyTarget.current = undefined; setFocusedMessage(""); loaded.current = undefined; stickToBottom.current = true; setShowScrollPill(false); }
    const savedDraft = draft, savedQuote = quote;
    drafts.current.delete(target);
    if (selected.current === target) { setDraft(""); setQuote(undefined); }
    setSendingBotId(target);
    setMessages((shown) => shown.some((row) => row.id === `optimistic:${clientId}`) ? shown : [...shown, optimisticOutgoing(clientId, content)]);
    void run(async () => {
      try {
        await api("agents/input", { botId: target, text: content, clientId, attachments: attachmentIds });
        setFiles(target, []);
        retry.current = undefined;
      } catch (error) {
        if (!drafts.current.has(target)) drafts.current.set(target, savedDraft);
        if (selected.current === target) {
          setDraft((current) => current || savedDraft);
          setQuote((current) => current ?? savedQuote);
        }
        throw error;
      }
    }).finally(() => setSendingBotId(undefined));
  };
  const bot = state?.bots.find((b) => b.id === botId), tasks = state?.tasks.filter((t) => t.bot_id === botId && !terminal.includes(str(t.status))) ?? [];
  useEffect(() => {
    const previous = previousTask.current;
    previousTask.current = tasks[0] ? { botId, taskId: str(tasks[0].id) } : undefined;
    setSettledState("idle");
    if (!tasks.length && previous?.botId === botId) {
      const settled = state?.tasks.find((task) => task.id === previous.taskId);
      if (settled?.status === "succeeded" || settled?.status === "failed") {
        setSettledState(settled.status === "succeeded" ? "done" : "failed");
        const timer = setTimeout(() => setSettledState("idle"), 2400);
        return () => clearTimeout(timer);
      }
    }
  }, [botId, tasks[0]?.id]);
  const avatarState = !connected ? "offline" : tasks.length ? companionState(tasks[0], state?.approvals.some((a) => a.bot_id === botId), connected) : sendingBotId === botId ? "thinking" : settledState;
  const processing = connected && !streaming.length && (sendingBotId === botId || tasks.some((task) => ["queued", "running", "cancelling"].includes(str(task.status))));
  const setFollowing = useCallback((next: boolean) => {
    stickToBottom.current = next;
    setShowScrollPill(!next && messagesRef.current.length > 3 && !historyTarget.current);
  }, []);
  const atEnd = () => {
    const el = scroll.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  // Content growth used to unpin follow via the distance check, so streaming
  // stopped at the send-time jump and the "回到底部" pill appeared. Follow now
  // breaks only on an upward gesture and tracks height while it stays armed.
  useBottomFollowResize(scroll, transcriptInner, stickToBottom, state ? `${botId}:${page}` : null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      if (event.key === "PageUp" || ((event.key === "Home" || event.key === "ArrowUp") && !typing)) setFollowing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFollowing]);
  useEffect(() => { setShowScrollPill(!stickToBottom.current && messages.length > 3 && !historyTarget.current); }, [messages]);
  useEffect(() => { const field = composerRef.current; if (field) { field.style.height = "auto"; field.style.height = `${Math.min(160, field.scrollHeight)}px`; } }, [draft, botId, page]);
  const descendantTasks = new Set(tasks.map((task) => task.id));
  for (let depth = 0; depth < 3; depth++) for (const link of state?.delegations ?? []) if (descendantTasks.has(link.parent_task_id)) descendantTasks.add(link.child_task_id);
  const waitingPeers = state?.approvals.filter((approval) => approval.bot_id !== botId && descendantTasks.has(approval.task_id)) ?? [];
  const peers = state?.bots.filter((b) => b.id !== botId) ?? [];
  const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  const matchingPeers = atMatch && !atDismissed ? peers.filter((p) => str(p.name).toLowerCase().includes(atMatch[1].toLowerCase())) : [];
  const applyMention = (name: string) => {
    const next = draft.replace(/@([^\s@]*)$/, `@${name} `);
    changeDraft(next); setAtDismissed(true); composerRef.current?.focus();
  };
  useEffect(()=>{
    if(!focusedMessage||scrolledTarget.current===focusedMessage)return;
    const message=scroll.current?.querySelector<HTMLElement>('[data-search-match="true"]');
    if(message){message.scrollIntoView({block:'center'});scrolledTarget.current=focusedMessage;}
  },[focusedMessage,messages,page]);
  const latestMessages=()=>{historyTarget.current=undefined;scrolledTarget.current='';setFocusedMessage('');loaded.current=undefined;stickToBottom.current=true;setMessages([]);setHistoryLoading(true);void reload().catch((e:Error)=>{setError(e.message);setHistoryLoading(false);});};
  const openSearchResult=(match:ConversationMatch)=>{
    ++serial.current;
    historyTarget.current={botId:match.botId,id:match.id};scrolledTarget.current='';setFocusedMessage(match.id);loaded.current=undefined;stickToBottom.current=false;
    setMessages([]);setStreaming([]);setHistoryLoading(true);setError('');setPage('agent');setSidebarOpen(false);
    if(selected.current===match.botId)void reload().catch((e:Error)=>{setError(e.message);setHistoryLoading(false);});
    else setBotId(match.botId);
  };
  const closeDialog = () => setDialog(null), select = (target: string) => { if(historyTarget.current && target===selected.current)latestMessages();historyTarget.current=undefined;scrolledTarget.current='';setFocusedMessage(''); setBotId(target); setPage("agent"); setSidebarOpen(false); setError(""); };
  const editAvatar = () => { if (bot && state) setDialog(<AvatarPicker bot={bot} firstId={str(state.bots[0]?.id)} onChange={async () => { setLookRevision((value) => value + 1); await reload(); }} close={closeDialog}/>); };
  const editBot = (existing?: RecordRow) => setDialog(<Editor title={existing ? "Agent 身份" : "添加 Agent"} onClose={closeDialog} fields={[{ name: "name", label: "名字", value: str(existing?.name), required: true }, { name: "instructions", label: "补充身份、职责与沟通方式（选填）", value: str(existing?.instructions), multiline: true, hint: "名字也是身份的一部分，留空也可以。修改后，其他 Agent 会自动获取最新资料。" }]} onSubmit={(data) => run(async () => { const result = await api<{ id: string }>(existing ? "bots/update" : "bots", { ...data, id: existing?.id, version: existing?.version }); if (!existing) { await reload(); select(result.id); } closeDialog(); })}/>);
  const editMemory = (existing?: RecordRow) => setDialog(<Editor title={existing ? "编辑记忆" : "添加记忆"} onClose={closeDialog} fields={[{ name: "title", label: "标题", value: str(existing?.title), required: true }, { name: "content", label: "记忆内容", value: str(existing?.content), multiline: true, required: true }, { name: "scope", label: "可见范围", value: str(existing?.scope) || "bot", choices: [{ value: "bot", label: `仅 ${bot?.name}` }, { value: "workspace", label: "与所有 Agent 共享" }] }]} onSubmit={(data) => run(async () => { await api("memory", { ...data, botId: existing?.bot_id ?? botId, documentId: existing?.id, expectedVersion: existing?.version ?? 0 }); closeDialog(); })}/>);
  const editRoutine = (existing?: RecordRow) => setDialog(<RoutineEditor botId={botId} existing={existing} close={closeDialog} runNow={existing ? () => run(async () => { await api("routines/run", { id: existing.id, clientId: crypto.randomUUID() }); closeDialog(); }) : undefined} save={(data) => run(async () => { await api("routines", data); closeDialog(); })}/>);
  const loadOlder = async () => {
    const snapshot = loaded.current;
    if (!snapshot?.messages.length) return;
    const result = await api<{ messages: RecordRow[]; sync: State["sync"] }>(`agents/messages?bot=${encodeURIComponent(snapshot.botId)}&before=${snapshot.messages[0].seq}`);
    const current = loaded.current;
    if (!current || current.botId !== snapshot.botId || current.sync.privacyEpoch !== result.sync.privacyEpoch || current.sync.bootId !== result.sync.bootId) return;
    const merged = [...result.messages, ...current.messages.filter((m) => !result.messages.some((old) => old.id === m.id))];
    loaded.current = { ...current, messages: merged };
    setMessages((shown) => withPendingOptimistic(merged, shown));
  };
  if (!state) return <div className="boot"><BrandMark size={44}/><h1>NexBot</h1><p>{error || "正在连接你的 Agent…"}</p>{desktop?.mode === "client" ? <button onClick={() => void desktop?.disconnect?.()}>返回连接页</button> : null}</div>;
  const botUsage = state.usage?.find((u) => u.bot_id === botId);
  const exportTranscript = async () => {
    const text = messages.map((m) => `[${formatTime(m.created_at)}] ${senderLabel(m, bot, state.bots)}: ${str(m.content)}`).join("\n\n");
    if (await writeCopyText(text) !== "copied") return;
    setExported(true); setTimeout(() => setExported(false), 1800);
  };
  const downloadTranscript = async () => {
    const target = botId, rows: RecordRow[] = [];
    let after = 0;
    const initial = state.sync;
    for (;;) {
      const feed = await api<{ messages: RecordRow[]; hasMore: boolean; sync: State["sync"] }>(`agents/messages?bot=${encodeURIComponent(target)}&after=${after}`);
      if (selected.current !== target || feed.sync.coreId !== initial.coreId || feed.sync.privacyEpoch !== initial.privacyEpoch) throw new Error("对话已变化，请重新导出");
      rows.push(...feed.messages);
      if (!feed.hasMore || !feed.messages.length) break;
      after = Number(feed.messages.at(-1)!.seq);
    }
    const current = await api<State>("state?view=summary");
    if (selected.current !== target || current.sync.coreId !== initial.coreId || current.sync.privacyEpoch !== initial.privacyEpoch) throw new Error("对话已变化，请重新导出");
    const content = rows.map((m) => `### ${senderLabel(m, bot, state.bots)} · ${formatTime(m.created_at)}\n\n${str(m.content)}`).join("\n\n---\n\n");
    const name = `${str(bot?.name).replace(/[\\/:*?"<>|]/g, "_") || "NexBot"}-对话.md`;
    if (desktop?.saveFile) { await desktop.saveFile(name, content); return; }
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const signOut = () => { void logout().catch(() => setError("退出登录未完成，请重试")); };
  const botLook = lookOf(bot, state.bots);
  const enabledTools: string[] = (() => { try { return JSON.parse(str(bot?.policy_json) || "{}").tools ?? []; } catch { return []; } })();
  const modelLabel = str(bot?.selected_model) || str(state.config?.default_model) || "未连接模型";
  const userDisplayName = accountStatus?.account?.displayName || "个人账号";
  void lookRevision;

  return <div className={`app rk-workspace ${page === "agent" && detail && bot ? "with-detail" : ""}`} data-motion={motion ? "on" : "off"} data-theme="studio" data-dark={dark ? "1" : "0"}>
    <ContactSidebar state={state} selectedId={botId} page={page} search={search} pinned={pinned} dark={dark} connected={connected} userName={userDisplayName} open={sidebarOpen} onSearch={setSearch} onSearchResult={openSearchResult} onSelect={select} onPage={() => openSettings()} onCreate={() => editBot()} onTheme={() => setDark((value) => !value)} onLogout={signOut} onClose={() => setSidebarOpen(false)}/>

    <main>
      <header>
        <button className="icon-button mobile-menu" aria-label="展开联系人列表" onClick={() => setSidebarOpen(true)}><PanelLeft size={19}/></button>
        <div className={`contact-heading ${page === "agent" && bot ? "clickable" : ""}`} onClick={() => { if (page === "agent" && bot) setDetail((current) => !current); }} title={page === "agent" && bot ? "点击展开或收起 Agent 资料" : undefined}>
          {page === "agent" && bot ? <>
            <Avatar bot={bot} allBots={state.bots} size={40} state={avatarState} animate/>
            <div>
              <div className="contact-title-row">
                <strong>{bot.name}</strong>
                <span className="ds-model-pill"><Zap size={10}/>{modelLabel}</span>
              </div>
              <span className={tasks.length ? "active-phrase" : ""}>{tasks.length ? `${taskPhrase(tasks[0])}${tasks.length > 1 ? ` · ${tasks.length} 项工作正在进行` : ""}` : companionLabels[avatarState]}</span>
            </div>
          </> : <strong>{page === "settings" ? "设置" : "你的 Agent"}</strong>}
        </div>
        <div className="header-actions">
          {page === "agent" && bot && memoryNotice ? <span className="memory-pill" role="status"><Sparkles size={13}/>已更新记忆：{memoryNotice}</span> : null}
          {page === "agent" && bot && messages.length > 0 ? <button type="button" className="bt-round" title="复制对话记录" onClick={() => exportTranscript()}>{exported ? <Check size={16}/> : <Share2 size={16}/>}</button> : null}
          {page === "agent" && bot ? <button aria-label="助手详情" title="Agent 资料" className={`bt-round ${detail ? "selected" : ""}`} onClick={() => setDetail(!detail)}><Info size={17}/></button> : null}
        </div>
      </header>

      {update?.status === "ready" ? <div role="status" className="update-banner">新版本 {update.version} 已就绪<button type="button" onClick={() => void desktop?.installUpdate?.().catch((e: Error) => setError(e.message))}>立即更新</button></div> : null}
      {error ? <div role="alert" className="error-banner">{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={16}/></button></div> : null}
      {!state.config && page !== "settings" ? <div className="notice model-chooser-notice"><div>连接模型后，Agent 就能开始工作。<button type="button" aria-expanded={modelChooserOpen} onClick={() => setModelChooserOpen((open) => !open)}>选择模型</button></div>{modelChooserOpen && <ModelSettings state={state} run={run} active={modelChooserOpen}/>}</div> : null}

      {page === "agent" && !bot ? <div className="welcome">
        <BrandMark size={64}/>
        <h1>创建你的第一个 Agent</h1>
        <p>给它一个名字，身份与职责可以之后补充。消息、记忆和工作会持续保留。</p>
        <button className="primary" onClick={() => editBot()}><Plus size={16}/>创建 Agent</button>
      </div> : page === "agent" ? <>
        <div className="transcript" ref={scroll} onPointerDown={(event) => { const el = scroll.current; if (el && event.target === el && event.nativeEvent.offsetX >= el.clientWidth) setFollowing(false); }} onWheel={(event) => { if (event.deltaY < 0) setFollowing(false); else if (atEnd()) setFollowing(true); }} onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? 0; }} onTouchMove={(event) => { const y = event.touches[0]?.clientY ?? 0; if (y > touchY.current + 4) setFollowing(false); else if (atEnd()) setFollowing(true); }} onScroll={() => { const el = scroll.current; if (!el) return; const scrollTop = el.scrollTop; const resume = shouldResumeBottomFollow({ following: stickToBottom.current, previousScrollTop: previousScrollTop.current, scrollTop, distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight }); previousScrollTop.current = scrollTop; if (resume) setFollowing(true); }}>
          <div className="transcript-inner" ref={transcriptInner}>
          {focusedMessage ? <button type="button" className="older" onClick={latestMessages}>返回最新消息</button> : null}
          {!focusedMessage && Number(messages[0]?.seq) > 1 ? <button className="older" onClick={() => void run(loadOlder)}>加载更早的消息</button> : null}
          {!messages.length && !processing && historyLoading ? <div className="history-loading" role="status"><span className="spin"/>正在载入历史会话…</div> : !messages.length && !processing ? <div className="welcome ds-welcome">
            <Avatar bot={bot} allBots={state.bots} large size={84} animate/>
            <div className="ds-welcome-badge" style={{ color: botLook.ink.solid, background: botLook.ink.soft }}>长期陪伴，随时开始</div>
            <h1>{bot?.name}</h1>
            <p>{str(bot?.instructions) || "我是你的专属智能同伴。你可以直接向我提问、安排定时任务，或输入 @ 让我与团队其他成员协作。"}</p>
            <small>直接发消息，或为我安排一项例行任务。</small>
            <div className="welcome-chips">
              <button type="button" onClick={() => editRoutine()}><Clock size={13}/>安排例行任务</button>
              <button type="button" onClick={() => editMemory()}><Sparkles size={13}/>添加长期记忆</button>
              {peers.length ? <button type="button" onClick={() => { changeDraft(`@${peers[0].name} `); composerRef.current?.focus(); }}><AtSign size={13}/>让 {peers[0].name} 协作</button> : null}
            </div>
          </div> : messages.map((m, idx) => {
            const prevDay = idx > 0 ? formatDay(messages[idx - 1].created_at) : "";
            const curDay = formatDay(m.created_at);
            return <div key={str(m.id)} data-search-match={m.id===focusedMessage?"true":undefined} className={m.id===focusedMessage?"search-message-target":undefined}>
              {curDay && curDay !== prevDay ? <div className="day-divider"><span>{curDay}</span></div> : null}
              <AgentMessage message={m} bot={bot} bots={state.bots} select={select} copiedId={copiedId} onCopy={copyText} onPreviewFile={openFilePreview} onPreviewStep={openStepPreview} onDeleteImage={deleteMessageImage} onQuote={(msg) => { const author = senderLabel(msg, bot, state.bots), parsed = parseMessageMedia(str(msg.content)); setQuote({ author, text: parsed.text || (parsed.images.length ? "图片" : "") }); composerRef.current?.focus(); }}/>
            </div>;
          })}
          {streaming.map((s) => {
            const link = state.delegations.find((d) => d.child_task_id === s.taskId), peer = state.bots.find((b) => b.id === link?.sender_bot_id);
            return <article className={`message assistant ${link ? "a2a-reply" : ""}`} key={s.taskId}>
              <Avatar bot={bot} allBots={state.bots} size={34} state={avatarState}/>
              <div className="message-body">
                {link ? <><div className="message-author"><strong>{bot?.name}</strong></div><FoldedReply content={s.text} recipient={str(peer?.name) || "Agent"} pending/></> : <><div className="ds-bot-author" style={{ color: botLook.ink.solid }}>{bot?.name}</div><div className="bubble"><RichText value={s.text} pending/></div><span className="muted">正在回复…</span></>}
              </div>
            </article>;
          })}
          {processing ? <article className="message assistant processing-message">
            <Avatar bot={bot} allBots={state.bots} size={34} state={avatarState}/>
            <div className="message-body">
              <div className="ds-bot-author" style={{ color: botLook.ink.solid }}>{bot?.name}</div>
              <div className="bubble processing-dots" role="status" aria-label={`${bot?.name ?? "Agent"} 正在处理消息`}><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>
              {tasks[0] ? <span className="muted processing-caption">{taskPhrase(tasks[0])}</span> : null}
            </div>
          </article> : null}
          </div>
        </div>

        <div className="composer-area">
          {showScrollPill && !focusedMessage ? <button type="button" className="scroll-pill" onClick={() => { setFollowing(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }}><ChevronDown size={14}/>回到底部</button> : null}
          {state.approvals.filter((a) => a.bot_id === botId).map((a) => <section className="approval" key={str(a.id)}><strong>{bot?.name} 需要你的批准</strong><small>{({ "agent.delegate": "联系其他 Agent", "agent.create": "创建新的 Agent", "agent.update": "修改 Agent 的名字和身份说明", "memory.write": "写入长期记忆", "memory.forget": "彻底遗忘原文与相关副本（相关工作会停止）", "device.read": "读取设备文件", "device.list": "查看设备目录", "device.exec": "执行终端命令", "device.computer": "操作电脑窗口", "connector.call": "调用连接器工具" } as Record<string, string>)[str(a.tool_name)] ?? a.tool_name}</small><details><summary>查看具体操作</summary><pre>{JSON.stringify({ ...JSON.parse(str(a.arguments_json)), ...(a.tool_name === "memory.forget" ? { 清理范围: JSON.parse(str(a.authorization_snapshot_json)).forgetCounts } : {}) }, null, 2)}</pre></details><div className="actions"><button className="primary" disabled={busy} onClick={() => void run(() => api("approvals", { id: a.id, hash: a.argument_hash, allow: true }))}>批准</button><button disabled={busy} onClick={() => void run(() => api("approvals", { id: a.id, hash: a.argument_hash, allow: false }))}>拒绝</button></div></section>)}
          {waitingPeers.map((approval) => <div className="task-status" key={str(approval.id)}><span>{state.bots.find((peer) => peer.id === approval.bot_id)?.name ?? "同伴"} 等待你的批准</span><button onClick={() => select(str(approval.bot_id))}>前往处理</button></div>)}
          {tasks.length > 0 && <div className="task-status"><span className="task-status-dot"/><span>{tasks.some((task) => task.status === "cancelling") ? "正在停止…" : (tasks[0].status === "needs_reconciliation" ? "设备未返回确认，等待核对结果" : `Agent 正在工作 · ${taskPhrase(tasks[0])}`)}</span></div>}
          {quote ? <div className="quote-bar"><div><strong>引用 {quote.author}</strong><span>{quote.text}</span></div><button type="button" aria-label="取消引用" onClick={() => setQuote(undefined)}><X size={14}/></button></div> : null}
          {matchingPeers.length > 0 ? <div className="at-menu" role="listbox" aria-label="提及同伴 Agent">{matchingPeers.map((peer, index) => <button type="button" key={str(peer.id)} className={index === atIndex ? "selected" : ""} onMouseDown={(e) => { e.preventDefault(); applyMention(str(peer.name)); }}><Avatar bot={peer} allBots={state.bots} size={28}/><div><strong>@{peer.name}</strong><span>{str(peer.instructions) || "同伴 Agent"}</span></div></button>)}</div> : null}
          <input ref={fileInput} type="file" hidden multiple aria-label="上传附件" onChange={(event) => void upload(event.target.files)}/>
          <form className="composer conversation-input" onSubmit={send}>
            {(attachments.length > 0 || pending.length > 0) && <div className="attachment-drafts" role="list" aria-label="待发送附件">
              {attachments.map((file) => file.previewUrl
                ? <button type="button" className="attachment-image-draft" key={file.id} role="listitem" aria-label={`查看图片 ${file.name}`} onClick={() => setDraftPreview({ src: file.previewUrl!, label: file.name })}>
                    <img className="attachment-thumb-tile" src={file.previewUrl} alt={file.name}/>
                  </button>
                : <div className="attachment-file-draft" key={file.id} role="listitem">
                    <span className="attachment-file-draft-icon" aria-hidden="true"><FileText size={15}/></span>
                    <span title={file.name}>{file.name}</span>
                    <button type="button" className="attachment-file-remove" aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => removeAttachment(file)}><X size={12}/></button>
                  </div>)}
              {pending.map((item) => item.error
                ? <div className="attachment-image-draft is-error" key={item.key} role="listitem" aria-label={`${item.file.name} 上传失败`} title={`${item.file.name}：${item.error}，点击重试`}>
                    <button type="button" className="attachment-thumb-tile is-error" aria-label={`上传失败：${item.file.name}，点击重试`} onClick={() => retryUpload(item)}><CircleAlert size={18}/></button>
                    <button type="button" className="attachment-tile-remove" aria-label={`移除 ${item.file.name}`} onClick={() => removePending(item)}><X size={12}/></button>
                  </div>
                : item.file.type.startsWith("image/") || isImageFileName(item.file.name)
                  ? <div className="attachment-image-draft is-uploading" key={item.key} role="listitem" aria-busy="true" aria-label={`${item.file.name} 正在上传`}>
                      <span className="attachment-thumb-tile is-uploading" aria-hidden="true"><ImageIcon size={18}/></span>
                    </div>
                  : <div className="attachment-file-draft" key={item.key} role="listitem" aria-busy="true">
                      <span className="attachment-file-draft-icon" aria-hidden="true"><FileText size={15}/></span>
                      <span title={item.file.name}>{item.file.name}</span>
                      <span className="attachment-upload-state" aria-hidden="true"><Loader2 size={13}/></span>
                      <button type="button" className="attachment-file-remove" aria-label={`取消上传 ${item.file.name}`} onClick={() => removePending(item)}><X size={12}/></button>
                    </div>)}
            </div>}
            <textarea ref={composerRef} aria-label="发送给 Agent 的消息" placeholder={`给 ${bot?.name ?? "Agent"} 发消息…`} value={draft} onChange={(e) => changeDraft(e.target.value)} onCompositionEnd={() => { imeEndedAt.current = Date.now(); }} onPaste={pasteImages} onKeyDown={(e) => { if (e.nativeEvent.isComposing || Date.now() - imeEndedAt.current < 150) return; if (e.key === "Enter" && e.shiftKey) return; if (matchingPeers.length > 0) { if (e.key === "ArrowDown") { e.preventDefault(); setAtIndex((i) => (i + 1) % matchingPeers.length); return; } if (e.key === "ArrowUp") { e.preventDefault(); setAtIndex((i) => (i - 1 + matchingPeers.length) % matchingPeers.length); return; } if (e.key === "Tab") { e.preventDefault(); applyMention(str(matchingPeers[atIndex]?.name ?? matchingPeers[0].name)); return; } if (e.key === "Escape") { e.preventDefault(); setAtDismissed(true); return; } } if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && Date.now() - imeEndedAt.current >= 150) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={Math.min(5, Math.max(1, draft.split("\n").length))}/>
            <ComposerControls key={JSON.stringify([botId,state.config?.provider_id,state.config?.endpoint])} visibleModels={state.modelVisibility?.models} mode={str(bot?.approval_setting) || "standard"} disabled={busy || !connected || !bot} uploading={uploading} canExport={messages.length > 0} onFile={() => fileInput.current?.click()} model={str(bot?.selected_model)} defaultModel={str(state.config?.default_model)} loadModels={() => listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: "" })} onModel={(model) => run(() => api("bots/model", { id: botId, model, provider: state.config?.provider_id, endpoint: state.config?.endpoint, version: Number(bot?.model_selection_version ?? 0) }))} onExport={() => void run(downloadTranscript)} onMode={(mode) => void run(() => api("bots/approval-mode", { id: botId, mode, version: Number(bot?.approval_setting_version ?? 0) }))}>
              {/* While the Agent works and nothing is typed, the send key stops it; typing turns it back into send. */}
              {tasks.length > 0 && !draft.trim() && !attachments.length && !pending.length
                ? <button type="button" className="send stop" aria-label="停止任务" title="停止任务" disabled={busy || !connected || tasks.every((task) => task.status === "cancelling")} onClick={() => void run(async () => { for (const task of tasks) await api("cancel", { taskId: task.id }); })}><Square size={14} fill="currentColor"/></button>
                : <button className="send" aria-label="发送消息" disabled={busy || uploading || (!draft.trim() && !attachments.length) || !state.config || !bot}><ArrowUp size={19}/></button>}
            </ComposerControls>
          </form>
        </div>
      </> : <SettingsPage state={state} run={run} category={settingsCategory} onCategory={setSettingsCategory} refresh={reload} setDialog={setDialog} closeDialog={closeDialog}/> }
    </main>

    {page === "agent" && detail && bot ? <aside className="inspector ds-drawer"><div className="inspector-heading"><span>助手详情</span><button aria-label="收起助手详情" className="icon-button" onClick={() => setDetail(false)}><X size={17}/></button></div>
      <div className="profile-top">
        <div className="ds-drawer-top-actions">
          <button type="button" className={`bt-round ${pinned.includes(str(bot.id)) ? "selected" : ""}`} title={pinned.includes(str(bot.id)) ? "取消置顶" : "置顶联系人"} onClick={() => togglePin(str(bot.id))}><Pin size={15}/></button>

        </div>
        <button type="button" className="profile-avatar-button" title="更换头像" aria-label={`更换 ${bot.name} 的头像`} onClick={editAvatar}><Avatar bot={bot} allBots={state.bots} size={64} state={avatarState} animate/></button>
        <strong>{bot.name}</strong>
        <div className="ds-drawer-badges">
          <span className="ds-role-badge" style={{ color: botLook.ink.solid, background: botLook.ink.soft }}>个人 Agent</span>
        </div>


      </div>

      <div className="inspector-tabs">
        {[{ id: "profile", name: "工作" }, { id: "settings", name: "设置" }].map((item) => <button key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? "selected" : ""} onClick={() => setTab(item.id)}>{item.name}</button>)}
      </div>

      <div className="inspector-content">
        {preview && tab === "profile" ? <section className="preview-card" aria-label="内容预览"><div className="preview-header"><div><strong>{preview.kind === "file" ? preview.title : toolLabels[preview.title] ?? preview.title}</strong><small>{preview.kind === "file" ? `${preview.path ?? preview.title}${preview.size !== undefined ? ` · ${preview.size} B` : ""}` : `${statuses[preview.status ?? ""] ?? preview.status ?? ""}${preview.createdAt ? ` · ${formatTime(preview.createdAt)}` : ""}`}</small></div><div className="preview-actions"><button type="button" onClick={() => copyText("preview", preview.content)}>{copiedId === "preview" ? "已复制" : "复制"}</button><button type="button" aria-label="关闭预览" onClick={() => setPreview(undefined)}><X size={14}/></button></div></div>{preview.arguments ? <details><summary>调用参数</summary><pre>{preview.arguments}</pre></details> : null}<pre>{preview.content || "暂无内容"}</pre></section> : null}

        {tab === "profile" ? <>

          {tasks.length > 0 && <h2>正在处理</h2>}
          {tasks.map((t) => <section className="task ds-field-card" key={str(t.id)}><span className="tag">{taskPhrase(t)}</span><p>{t.objective || "Agent 工作"}</p><div className="actions">{t.status === "paused" ? <button onClick={() => void run(() => api("resume", { taskId: t.id }))}><Play size={12}/>继续</button> : null}<button onClick={() => void run(() => api("cancel", { taskId: t.id }))}><Square size={12}/>停止</button></div></section>)}

          {state.occurrences.some((o) => o.bot_id === botId) && <h2>最近执行</h2>}
          {state.occurrences.filter((o) => o.bot_id === botId).slice(0, 10).map((o) => <section className="task ds-field-card" key={str(o.id)}><strong>{o.name}</strong><small>{statuses[str(o.status)]} · {formatTime(o.scheduled_at)}</small></section>)}

          <h2>例行任务<button aria-label="添加例行任务" onClick={() => editRoutine()}><Plus size={16}/></button></h2>
          {state.routines.some((r) => r.bot_id === botId) ? <div className="routine-list" aria-label="例行任务列表">
            {state.routines.filter((r) => r.bot_id === botId).map((r) => <div className="routine-row" key={str(r.id)}>
              <button type="button" className="routine-summary" onClick={() => editRoutine(r)} title={`${r.name} · ${routineLabel(r)} · ${r.prompt}`}><strong>{r.name}</strong><span>{routineLabel(r)} · {r.prompt}</span></button>
              <button type="button" role="switch" aria-checked={!!r.enabled} aria-label={`${r.name}`} disabled={busy} className={`routine-toggle ${r.enabled ? "on" : ""}`} onClick={() => void run(() => api("routines/toggle", { id: r.id, version: r.version, enabled: !r.enabled }))}><span/></button>
            </div>)}
          </div> : null}

        </> : null}
        {tab === "settings" ? <>

          <section className="agent-configuration"><h2>助手设置</h2><div>          <div className="ds-field-group">
            <div className="ds-field-label">关于</div>
            <div className="ds-field-card">
              <BotIdentity key={str(bot.id)} bot={bot} refresh={reload}/>
            </div>
          </div>

          <div className="ds-field-group">
            <div className="ds-field-label">能力</div>
            <div className="ds-field-card ds-kv-list">
              <div className="ds-kv-row">
                <span><Zap size={13}/>驱动模型</span>
                <ModelPicker key={JSON.stringify([botId, state.config?.provider_id, state.config?.endpoint])} label="驱动模型" triggerClassName="ds-pill-btn inspector-model-trigger" displayValue={modelLabel} value={str(bot.selected_model)} emptyLabel={`跟随默认（${str(state.config?.default_model) || "未设置"}）`} models={state.modelVisibility?.models} disabled={busy || !connected} loadModels={() => listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: "" })} onChange={(model) => { void run(() => api("bots/model", { id: botId, model, provider: state.config?.provider_id, endpoint: state.config?.endpoint, version: Number(bot.model_selection_version ?? 0) })); }}/>
              </div>
              <div className="ds-kv-row">
                <span><Shield size={13}/>工具权限</span>
                <button type="button" className="ds-pill-btn" onClick={() => setDialog(<AgentPolicyEditor bot={bot} close={closeDialog} save={(tools) => run(async () => { await api("bots/policy", { id: bot.id, version: bot.policy_version, tools }); closeDialog(); })}/>)}>已授权 {enabledTools.length} 项 · 配置</button>
              </div>

            </div>
          </div>

          <div className="ds-field-group">
            <div className="ds-field-label">用量</div>
            <div className="ds-field-card usage-card">
              <div className="ds-usage-grid">
                <div><small>累计调用</small><strong>{Number(botUsage?.calls ?? 0)} 次</strong></div>
                <div><small>输入 Token</small><strong>{Number(botUsage?.input_tokens ?? 0).toLocaleString()}</strong></div>
                <div><small>输出 Token</small><strong>{Number(botUsage?.output_tokens ?? 0).toLocaleString()}</strong></div>
              </div>
            </div>
          </div>

</div></section>
          <div className="profile-actions">
            {messages.length > 0 ? <button className="text-button" onClick={() => exportTranscript()}>{exported ? "已复制记录" : "导出记录"}</button> : null}
            <button className="text-button danger-link" onClick={() => setDialog(<Confirm title="归档这个 Agent？" detail="保留消息与记忆，停用例行任务。" onClose={closeDialog} onConfirm={() => run(async () => { await api("bots/archive", { id: bot.id, version: bot.version }); closeDialog(); })}/>)}>归档 Agent</button>
          </div>
        </> : null}


      </div>
    </aside> : null}

    {dialog ? <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === "Escape") closeDialog(); }}><div className="modal" role="dialog" aria-modal="true">{dialog}</div></div> : null}
    {draftPreview ? <ImageLightbox src={draftPreview.src} alt={draftPreview.label} deleteLabel="移除图片" onClose={() => setDraftPreview(undefined)} onDelete={() => removeDraftImage(draftPreview.src)}/> : null}
  </div>;
}

function A2AMarker({ direction, peer, bots, timestamp, select }: { direction: string; peer?: RecordRow; bots: RecordRow[]; timestamp: RecordRow[string]; select: (id: string) => void }) {
  return <div className="a2a-marker" data-a2a-direction={direction}><span>{direction === "sent" ? "已发消息给" : "消息来自"}</span><button className="a2a-contact" aria-label={`打开 ${peer?.name ?? "Agent"} 的消息`} disabled={!peer} onClick={() => { if (peer) select(str(peer.id)); }}><Avatar bot={peer} allBots={bots} size={20}/><span>{peer?.name ?? "Agent"}</span></button><time title={timestamp ? new Date(Number(timestamp)).toLocaleString("zh-CN") : undefined}>{formatTime(timestamp)}</time></div>;
}
function FoldedReply({ content, recipient, pending = false }: { content: string; recipient: string; pending?: boolean }) {
  return <details className="bubble folded-content folded-reply"><summary><span className="reply-recipient">{pending ? "正在回复给" : "已回复给"}{recipient}</span><span aria-hidden="true">·</span><span className="expand-label">展开</span><span className="collapse-label">收起</span><ChevronDown size={13}/></summary><div className="folded-body" data-reply-content><RichText value={content} pending={pending}/></div></details>;
}
function senderLabel(m: RecordRow, bot: RecordRow | undefined, bots: RecordRow[]) {
  if (m.role === "user") return "我";
  if (m.role === "system") return "系统";
  if (m.role === "peer") return str(bots.find((b) => b.id === (m.a2a_peer_id ?? m.sender_bot_id))?.name) || "同伴 Agent";
  return str(bot?.name) || "Agent";
}
function AgentMessage({ message: m, bot, bots, select, copiedId, onCopy, onQuote, onPreviewFile, onPreviewStep, onDeleteImage }: { message: RecordRow & { tool_steps?: ToolStep[] }; bot?: RecordRow; bots: RecordRow[]; select: (id: string) => void; copiedId: string; onCopy: (id: string, text: string) => void; onQuote: (msg: RecordRow) => void; onPreviewFile: (path: string) => void; onPreviewStep: (step: ToolStep) => void; onDeleteImage: (messageId: string, image: MessageImage) => Promise<void> }) {
  const direction = str(m.a2a_direction), peer = bots.find((b) => b.id === (m.a2a_peer_id ?? m.sender_bot_id));
  if (direction === "sent" || direction === "returned") return <A2AMarker direction={direction} peer={peer} bots={bots} timestamp={m.created_at} select={select}/>;
  if (direction === "received") return <A2AMarker direction={direction} peer={peer} bots={bots} timestamp={m.created_at} select={select}/>;
  if (direction === "replied" && m.role === "assistant") return <article className="message assistant a2a-reply"><Avatar bot={bot} allBots={bots} size={34}/><div className="message-body"><div className="message-author"><strong>{bot?.name ?? "Agent"}</strong></div><FoldedReply content={str(m.content)} recipient={peer?.name ? str(peer.name) : "Agent"}/><time>{formatTime(m.created_at)}</time></div></article>;
  const canAct = m.role === "user" || m.role === "assistant" || m.role === "peer";
  const steps = Array.isArray(m.tool_steps) ? m.tool_steps : [];
  const { text, images } = parseMessageMedia(str(m.content));
  return <article className={`message ${m.role} ${m.kind}`} data-message-id={str(m.id)}>
    <div className="message-body">
      {m.role === "peer" ? <div className="message-author"><Avatar bot={peer} allBots={bots} size={22}/>{peer?.name ?? "Agent"} · {m.kind === "request" ? "发来任务" : "返回结果"}</div> : null}
      {steps.length > 0 ? <ToolActivityDisclosure live={false} stepCount={steps.length}><div className="step-list">{steps.map((step) => <button type="button" key={step.id} className="step-row" onClick={() => onPreviewStep(step)} title="点击在右侧面板查看详情"><span className={`step-dot ${step.status}`}/><strong>{toolLabels[step.tool_name] ?? step.tool_name}</strong>{step.summary ? <code>{step.summary}</code> : null}<small>{statuses[step.status] ?? step.status}</small></button>)}</div></ToolActivityDisclosure> : null}
      <MessageImages images={images} onDelete={(image) => onDeleteImage(str(m.id), image)}/>
      {text ? <div className="bubble"><RichText value={text} onPreviewFile={onPreviewFile}/></div> : null}
      <div className="message-meta"><time title={formatTime(m.created_at)}>{formatShortTime(m.created_at)}</time>{canAct ? <span className="message-tools"><button type="button" className="tool-link" onClick={() => onQuote(m)} title="引用回复"><CornerUpLeft size={11}/>引用</button><button type="button" className="tool-link" onClick={() => onCopy(str(m.id), str(m.content))} title="复制内容">{copiedId === str(m.id) ? <><Check size={11}/>已复制</> : <><Copy size={11}/>复制</>}</button></span> : null}</div>
    </div>
  </article>;
}
function routineLabel(row: RecordRow) { return row.schedule_kind === "daily" ? `每天 ${row.local_time} · ${row.time_zone}` : row.schedule_kind === "interval" ? `每 ${Number(row.interval_ms) / 60_000} 分钟` : "一次性任务"; }
function RoutineEditor({ botId, existing, close, save, runNow }: { botId: string; existing?: RecordRow; close: () => void; runNow?: () => Promise<void>; save: (data: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState(str(existing?.schedule_kind) || "daily"), [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{existing ? "编辑例行任务" : "添加例行任务"}</h2><button aria-label="关闭" onClick={close}><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); setPending(true); void save({ ...data, botId, id: existing?.id, version: existing?.version, runAt: data.runAt ? new Date(String(data.runAt)).getTime() : undefined }).finally(() => setPending(false)); }}><label className="field">名称<input autoFocus name="name" required defaultValue={str(existing?.name)} placeholder="例如：每日工作计划"/></label><label className="field">让 Agent 做什么<textarea name="prompt" required rows={4} defaultValue={str(existing?.prompt)} placeholder="描述目标、需要参考的资料和汇报方式"/></label><label className="field">执行计划<select name="scheduleKind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="daily">每天</option><option value="interval">固定间隔</option><option value="once">指定时间执行一次</option></select></label>{kind === "daily" ? <label className="field">每天的时间<input name="localTime" type="time" required defaultValue={str(existing?.local_time) || "09:00"}/></label> : kind === "interval" ? <label className="field">间隔（分钟）<input name="intervalMinutes" type="number" min="1" max="525600" required defaultValue={existing?.interval_ms ? Number(existing.interval_ms) / 60_000 : 60}/></label> : <label className="field">执行时间（本机时间）<input name="runAt" type="datetime-local" required/></label>}<label className="field">时区<input name="timeZone" required defaultValue={str(existing?.time_zone) || Intl.DateTimeFormat().resolvedOptions().timeZone}/></label><p className="muted">按计划唤醒 Agent 会调用你配置的模型。需要批准的工具操作仍会等待你处理。</p><div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={close}>取消</button>{runNow ? <button type="button" disabled={pending} onClick={() => { setPending(true); void runNow().finally(() => setPending(false)); }}><Play size={12}/>现在执行</button> : null}</div></form></>;
}
