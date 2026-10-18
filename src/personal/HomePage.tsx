import { ArrowRight, ArrowUp, Bot, CalendarClock, Check, Cpu, Download, FileText, Globe, Laptop, LoaderCircle, MonitorSmartphone, Plug, Plus, ShieldCheck, Smartphone, SquareTerminal } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { BrandMark } from "./components/BrandMark";
import { AgentAvatar } from "./components/AgentAvatar";
import type { Appearance } from "./avatars/appearance";

const repo = "https://github.com/DarrenHoo-10/nex_bot";
export const registerUrl = "https://user.nexorai.com.cn/register/nexbot";
const links = { releases: `${repo}/releases`, apple: `${repo}/tree/main/apps/apple` };

interface ClientDownload { url: string; version: string; publishedAt: string }
interface ClientDownloads { windows?: ClientDownload; android?: ClientDownload }
/** Core resolves the newest GitHub release; until it answers (or on an older Core) the cards open the release list. */
function useClientDownloads() {
  const [downloads, setDownloads] = useState<ClientDownloads>({});
  useEffect(() => {
    let live = true;
    void fetch("/api/client/downloads").then((response) => response.ok ? response.json() as Promise<ClientDownloads> : {}).then((value) => { if (live) setDownloads(value); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return downloads;
}

const work: Appearance = { kind: "companion", shape: "soft", color: "teal" };
const research: Appearance = { kind: "companion", shape: "bean", color: "blue" };
const writing: Appearance = { kind: "companion", shape: "pebble", color: "clay" };

const features = [
  { icon: Bot, title: "专属助手", text: "为写作、研究、工作整理分别创建助手，各有名字、身份和职责。" },
  { icon: MonitorSmartphone, title: "跨设备接着聊", text: "每个助手保留自己的对话，电脑、手机和网页用同一账号继续。" },
  { icon: FileText, title: "处理文件", text: "上传文档、PDF 和图片，让助手阅读、总结和整理。" },
  { icon: SquareTerminal, title: "操作电脑", text: "Windows 和 Mac 客户端登录后连接本机，助手可读取文件、运行命令。" },
  { icon: Plug, title: "连接工具", text: "添加 MCP 连接器，按助手分别授权可用的工具。" },
  { icon: CalendarClock, title: "例行任务", text: "设定重复执行的工作，结果直接回到对话里。" },
  { icon: Cpu, title: "自选模型", text: "连接自己的模型服务，按助手切换模型、调整上下文与输出。" },
  { icon: ShieldCheck, title: "关键操作你来定", text: "删除、覆盖、发消息等操作先请你批准，随时可以停止。" },
];

function platforms({ windows, android }: ClientDownloads) {
  return [
    { icon: Laptop, name: "Windows", detail: windows ? `${windows.version} · x64 便携版，免安装` : "x64 便携版，免安装", note: "可让助手操作这台电脑", href: windows?.url ?? links.releases, action: windows ? "下载 EXE" : "前往 GitHub 下载" },
    { icon: Smartphone, name: "Android", detail: android ? `${android.version} · Android 8.0 及以上` : "Android 8.0 及以上", note: "查看消息、发送任务、处理审批", href: android?.url ?? links.releases, action: android ? "下载 APK" : "前往 GitHub 下载" },
    { icon: Globe, name: "网页版", detail: "浏览器直接使用", note: "对话和管理助手，无需安装", href: "#login", action: "立即登录" },
    { icon: MonitorSmartphone, name: "Mac 与 iPhone", detail: "原生客户端", note: "需从源码构建", href: links.apple, action: "构建说明" },
  ];
}
function releaseNote({ windows, android }: ClientDownloads) {
  const published = [windows?.publishedAt, android?.publishedAt].filter(Boolean).sort().at(-1);
  const date = published ? new Date(published).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "";
  return `${date ? `最新预览版发布于 ${date}。` : "安装包发布在 GitHub。"}Windows 包尚无发布者签名，Android 包为测试签名。`;
}

const steps = [
  { title: "注册账号", text: "使用邀请码注册 NexorAI 账号，邀请码由服务运营方提供。" },
  { title: "连接模型", text: "在「设置 → 模型」填写服务地址和 API Key，获取模型列表。" },
  { title: "创建助手", text: "点击左上角「＋」，给助手起名字、写好职责，然后交给它第一件事。" },
];

function external(href: string) { return href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {}; }
/** Login lives in the hero; every "登录" link brings it into view and puts the cursor in the email field. */
function toLogin(event: MouseEvent) {
  const card = document.getElementById("login"), email = card?.querySelector<HTMLInputElement>('input[name="email"]');
  if (!card) return;
  event.preventDefault();
  card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  email?.focus({ preventScroll: true });
}

function ProductPreview() {
  return <div className="home-preview" aria-hidden="true">
    <div className="home-window">
      <div className="home-window-bar"><i/><i/><i/><span>bot.nexorai.com.cn</span></div>
      <div className="home-window-body">
        <aside className="home-mock-sidebar">
          <div className="home-mock-brand"><BrandMark size={22}/><strong>NexBot</strong><Plus size={15}/></div>
          <div className="home-mock-search">搜索联系人</div>
          <p className="home-mock-label">对话</p>
          <div className="home-mock-contact is-selected"><AgentAvatar appearance={work} size={34} state="working" animate/><div><strong>工作助手</strong><span>正在生成周报草稿…</span></div></div>
          <div className="home-mock-contact"><AgentAvatar appearance={research} size={34}/><div><strong>研究伙伴</strong><span>找到 3 篇相关资料</span></div></div>
          <div className="home-mock-contact"><AgentAvatar appearance={writing} size={34}/><div><strong>写作搭子</strong><span>初稿已保存到文档</span></div></div>
        </aside>
        <div className="home-mock-chat">
          <header><AgentAvatar appearance={work} size={34} state="working" animate/><div><strong>工作助手</strong><span>正在执行</span></div></header>
          <div className="home-mock-transcript">
            <p className="home-mock-user">把本周的项目进展整理成周报，发给团队前先给我看一下。</p>
            <p className="home-mock-reply">好的。我先读取项目记录，按模块汇总进展和风险。</p>
            <ul className="home-mock-steps">
              <li><Check size={13}/>读取 项目记录 / 第 42 周</li>
              <li><Check size={13}/>汇总 6 项进展、2 个风险</li>
              <li className="is-running"><LoaderCircle size={13}/>生成 周报草稿.docx</li>
            </ul>
            <div className="home-mock-approval"><ShieldCheck size={16}/><div><strong>发送给团队前需要你确认</strong><span>收件人：项目组 · 附件：周报草稿.docx</span></div><b>确认发送</b></div>
          </div>
          <div className="home-mock-composer"><Plus size={15}/><span>给 工作助手 发消息…</span><i><ArrowUp size={14}/></i></div>
        </div>
      </div>
    </div>
    <div className="home-float home-float-routine"><CalendarClock size={16}/><div><strong>每周五 17:00</strong><span>整理工作周报</span></div><i className="home-toggle"/></div>
    <div className="home-float home-float-device"><span className="home-dot"/><div><strong>我的电脑</strong><span>在线 · 可执行任务</span></div></div>
  </div>;
}

export function HomePage({ login }: { login: ReactNode }) {
  const downloads = useClientDownloads();
  return <div className="home">
    <header className="home-nav">
      <a className="home-logo" href="#top"><BrandMark size={30}/><strong>NexBot</strong></a>
      <nav aria-label="主导航"><a href="#features">功能</a><a href="#platforms">下载</a><a href="#start">上手</a></nav>
      <div className="home-nav-actions"><a href="#login" onClick={toLogin}>登录</a><a className="home-button is-dark" href={registerUrl} {...external(registerUrl)}>注册</a></div>
    </header>
    <main id="top">
      <section className="home-hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">NexorAI · 个人 AI 助手</p>
          <h1>把 AI 助手<br/>放进你的日常工作</h1>
          <p className="home-lede">为不同事情创建专属助手。在电脑、手机和网页上接着聊，让助手处理文件、调用工具，按计划完成例行任务。</p>
          <div className="home-cta">
            <a className="home-button is-primary" href={registerUrl} {...external(registerUrl)}>注册账号<ArrowRight size={16}/></a>
            <a className="home-button" href="#platforms"><Download size={16}/>下载客户端</a>
          </div>
          <ul className="home-proof"><li>Windows</li><li>Android</li><li>Mac</li><li>iPhone</li><li>网页</li></ul>
        </div>
        <div id="login" className="home-login login-screen">{login}</div>
      </section>
      <section className="home-showcase"><ProductPreview/></section>
      <section id="features" className="home-section">
        <div className="home-section-head"><p className="home-eyebrow">功能</p><h2>一个账号，一组各司其职的助手</h2></div>
        <div className="home-features">{features.map(({ icon: Icon, title, text }) => <article key={title}><span className="home-icon"><Icon size={19}/></span><h3>{title}</h3><p>{text}</p></article>)}</div>
      </section>
      <section id="platforms" className="home-section">
        <div className="home-section-head"><p className="home-eyebrow">下载</p><h2>在常用的设备上使用</h2><p>{releaseNote(downloads)}</p></div>
        <div className="home-platforms">{platforms(downloads).map(({ icon: Icon, name, detail, note, href, action }) => <a key={name} href={href} {...external(href)} onClick={href === "#login" ? toLogin : undefined}>
          <span className="home-icon"><Icon size={19}/></span><strong>{name}</strong><span>{detail}</span><small>{note}</small><b>{action}<ArrowRight size={14}/></b>
        </a>)}</div>
        <p className="home-release-link"><a href={links.releases} {...external(links.releases)}>查看全部版本与校验文件</a></p>
      </section>
      <section id="start" className="home-section">
        <div className="home-section-head"><p className="home-eyebrow">上手</p><h2>三步开始</h2></div>
        <ol className="home-steps">{steps.map(({ title, text }, index) => <li key={title}><span>{index + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol>
      </section>
      <section className="home-closing">
        <h2>交给助手的第一件事，现在就可以开始</h2>
        <div className="home-cta"><a className="home-button is-primary" href="#login" onClick={toLogin}>登录网页版<ArrowRight size={16}/></a><a className="home-button is-ghost" href={registerUrl} {...external(registerUrl)}>注册账号</a></div>
      </section>
    </main>
    <footer className="home-footer"><span><BrandMark size={20}/>NexBot · NexorAI</span><nav><a href={links.releases} {...external(links.releases)}>版本发布</a><a href={registerUrl} {...external(registerUrl)}>注册</a><a href={repo} {...external(repo)}>GitHub</a></nav></footer>
  </div>;
}
