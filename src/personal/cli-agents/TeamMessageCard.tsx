// Structured collaboration ("协作") message card rendered in TranscriptView
// with distinct semantic primary colors per task/message type.
import { lazy, Suspense } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileCode2,
  HelpCircle,
  MessageSquareReply,
  Send,
  Wrench,
  XCircle,
} from "lucide-react";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { HarnessMark } from "./tokendance/HarnessMark";
import { TEAM_FINDING_SEVERITY_LABEL, type CliTeamCard, type CliTeamCardKind } from "./team";

const RichText = lazy(() => import("../AgentDesktop").then((module) => ({ default: module.RichText })));

const CARD_KIND_BADGE: Record<CliTeamCardKind, string> = {
  task: "派发",
  report: "汇报",
  review: "审查",
  followup: "修改",
  question: "提问",
  answer: "答复",
  nudge: "催促",
  escalation: "异常",
  done: "交付",
};

function cardIcon(card: CliTeamCard) {
  if (card.outcome === "failed") return XCircle;
  switch (card.kind) {
    case "task":
      return Send;
    case "report":
    case "done":
      return CheckCircle2;
    case "review":
      return ClipboardCheck;
    case "followup":
      return Wrench;
    case "question":
      return HelpCircle;
    case "answer":
      return MessageSquareReply;
    case "nudge":
      return Bell;
    case "escalation":
      return AlertTriangle;
  }
}

export function TeamMessageCard({
  card,
  onSelectSession,
}: {
  card: CliTeamCard;
  onSelectSession?(key: CliSessionKey): void;
}) {
  const Icon = cardIcon(card);
  const jumpKey = card.sourceSessionKey ?? card.targetSessionKey;
  const badge = card.outcome === "failed" ? "失败" : CARD_KIND_BADGE[card.kind];
  const hasContent = Boolean(card.body || card.findings?.length || card.files?.length);

  return (
    <article
      className="na-team-card"
      data-kind={card.kind}
      data-outcome={card.outcome}
      data-has-findings={card.findings?.length ? "1" : undefined}
      data-testid="cli-team-card"
    >
      <header className="na-team-card-head">
        <span className="na-team-card-mark" aria-hidden="true">
          {card.actorEngine ? <HarnessMark agentId={card.actorEngine} size="sm" /> : <Icon size={14} />}
        </span>
        <span className="na-team-card-tag">{badge}</span>
        <div className="na-team-card-heading">
          <strong>{card.heading}</strong>
          {card.subtitle ? <span className="na-team-card-sub">· {card.subtitle}</span> : null}
        </div>
        <div className="na-team-card-right">
          {card.outcome ? (
            <span className="na-team-status" data-tone={card.outcome === "failed" ? "failed" : "reported"}>
              {card.outcome === "failed" ? "失败" : "已完成"}
            </span>
          ) : null}
          {jumpKey && onSelectSession ? (
            <button
              type="button"
              className="na-team-card-jump"
              aria-label={`打开关联会话：${card.subtitle || card.heading}`}
              onClick={() => onSelectSession(jumpKey)}
            >
              <span>查看</span>
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {hasContent ? (
        <div className="na-team-card-content">
          {card.body ? (
            <div className="na-team-card-body markdown">
              <Suspense fallback={<p className="cli-plain">{card.body}</p>}>
                <RichText value={card.body} />
              </Suspense>
            </div>
          ) : null}

          {card.findings?.length ? (
            <ul className="na-team-findings" aria-label="审查问题列表">
              {card.findings.map((finding, index) => {
                const sev = finding.severity.toLowerCase();
                return (
                  <li key={`${finding.file}:${finding.line ?? index}`} className="na-team-finding">
                    <span className="na-team-severity" data-severity={sev}>
                      {TEAM_FINDING_SEVERITY_LABEL[sev] ?? finding.severity}
                    </span>
                    <div className="na-team-finding-detail">
                      <code className="na-team-finding-loc">
                        {finding.file}{finding.line ? `:${finding.line}` : ""}
                      </code>
                      <span>{finding.issue}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {card.files?.length ? (
            <div className="na-team-files" aria-label="涉及文件">
              {card.files.map((file) => (
                <span key={file} className="na-team-file">
                  <FileCode2 size={12} aria-hidden="true" />
                  <span>{file}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
