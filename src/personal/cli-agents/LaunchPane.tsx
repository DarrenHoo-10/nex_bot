// A session that is still being started, laid out like any conversation: the user's first message,
// the agent's reply slot saying it is being handled (or why it did not start), and the message box.
import { ArrowLeft, ArrowUp, Plus, RotateCcw, X } from "lucide-react";
import { ConversationActionButton } from "../components/ConversationActionButton";
import { HarnessMark } from "./tokendance/HarnessMark";
import { EchoMessage, WorkingRow } from "./TranscriptView";
import type { Launch } from "./use-launches";
import { AGENT_LABEL } from "./session-model";

export function LaunchPane({ launch, onBack, onRetry, onDismiss }: { launch: Launch; onBack(): void; onRetry(): void; onDismiss(): void }) {
  const failed = launch.phase === "failed";
  const heading = launch.message.split("\n")[0]?.trim() || "新会话";
  return (
    <section className="cli-pane" aria-label={heading} data-testid="cli-launch">
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18}/></button>
        <div className="cli-pane-title">
          <strong title={heading}>{heading}</strong>
        </div>
        <span className="cli-chip" data-tone={failed ? "stopped" : "running"}>{failed ? "未启动" : "运行中"}</span>
      </header>
      <div className="cli-pane-body na-conversation-body">
        <div className="cli-transcript"><div className="cli-transcript-list">
          {launch.message ? <EchoMessage text={launch.message}/> : null}
          {failed ? <div className="cli-msg is-assistant na-launch-reply" data-testid="cli-launch-reply">
            <div className="na-byline"><HarnessMark agentId={launch.engine}/><b>{AGENT_LABEL[launch.engine]}</b></div>
            <div className="cli-notice na-launch-error" data-level="error" role="alert">
              <span>{launch.error}</span>
              <ConversationActionButton onClick={onRetry}><RotateCcw size={13} aria-hidden="true"/>重试</ConversationActionButton>
              <ConversationActionButton tone="dark" onClick={onDismiss}><X size={13} aria-hidden="true"/>关闭</ConversationActionButton>
            </div>
          </div> : <WorkingRow engine={launch.engine} label="执行中" byline/>}
        </div></div>
      </div>
      {/* the message box of the session to come: usable once it is running */}
      <div className="cli-composer na-message-box na-launch-composer" aria-hidden="true">
        <textarea tabIndex={-1} disabled rows={1} placeholder="发消息，或输入 / 使用技能"/>
        <div className="cli-composer-actions">
          <button type="button" tabIndex={-1} disabled className="na-add-trigger"><Plus size={20}/></button>
          <span className="na-grow"/>
          <button type="submit" tabIndex={-1} disabled className="primary"><ArrowUp size={19}/></button>
        </div>
      </div>
    </section>
  );
}
