// A session that is still being started: the user's first message, and that it is being handled.
import { ArrowLeft, LoaderCircle, RotateCcw, X } from "lucide-react";
import { EchoMessage } from "./TranscriptView";
import type { Launch } from "./use-launches";
import { AGENT_LABEL, folderLabel } from "./session-model";

export function LaunchPane({ launch, onBack, onRetry, onDismiss }: { launch: Launch; onBack(): void; onRetry(): void; onDismiss(): void }) {
  const failed = launch.phase === "failed";
  const heading = launch.message.split("\n")[0]?.trim() || "新会话";
  return (
    <section className="cli-pane" aria-label={heading} data-testid="cli-launch">
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18}/></button>
        <div className="cli-pane-title">
          <strong title={heading}>{heading}</strong>
          <small>{AGENT_LABEL[launch.engine]} · {folderLabel(launch.cwd)}{launch.branch ? ` · ${launch.branch}` : ""}</small>
        </div>
        <span className="cli-chip" data-tone={failed ? "stopped" : "running"}>{failed ? "未启动" : "运行中"}</span>
      </header>
      <div className="cli-pane-body na-conversation-body">
        <div className="cli-transcript"><div className="cli-transcript-list">
          {launch.message ? <EchoMessage text={launch.message} at={launch.createdAt}/> : null}
        </div></div>
      </div>
      {failed ? <div className="cli-banner" role="alert">
        {launch.error}
        <button type="button" className="text-button" onClick={onRetry}><RotateCcw size={13}/>重试</button>
        <button type="button" className="text-button" onClick={onDismiss}><X size={13}/>关闭</button>
      </div> : <div className="na-progress" role="status"><LoaderCircle className="na-busy-icon" size={14}/><span>处理中…</span></div>}
    </section>
  );
}
