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
import { type CliTeamCard, type CliTeamCardKind } from "./team";

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

const MAX_BRIEF_FILES = 4;

function severityTone(severity: string): "high" | "medium" | "low" {
  const sev = severity.toLowerCase();
  if (sev === "p0" || sev === "p1" || sev === "critical" || sev === "high") return "high";
  if (sev === "p2" || sev === "medium") return "medium";
  return "low";
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
  const isBriefing = card.kind === "report" || card.kind === "review";
  const displayText = isBriefing ? (card.brief || card.body) : card.body;
  const findingCounts = card.findingCounts ?? [];
  const totalFindings = findingCounts.reduce((sum, entry) => sum + entry.count, 0);
  const showReviewStrip = card.kind === "review" && (findingCounts.length > 0 || card.outcome !== "failed");
  const visibleFiles = card.files?.slice(0, MAX_BRIEF_FILES) ?? [];
  const hiddenFiles = Math.max(0, (card.files?.length ?? 0) - visibleFiles.length);
  const hasContent = Boolean(displayText || showReviewStrip || visibleFiles.length);

  return (
    <article
      className="na-team-card"
      data-kind={card.kind}
      data-outcome={card.outcome}
      data-brief={isBriefing ? "1" : undefined}
      data-has-findings={totalFindings > 0 ? "1" : undefined}
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
          {showReviewStrip ? (
            <div className="na-team-brief-counts" aria-label="审查问题简报">
              {findingCounts.length > 0 ? (
                <>
                  <span className="na-team-brief-total">发现 {totalFindings} 个问题</span>
                  {findingCounts.map((entry) => (
                    <span key={entry.severity} className="na-team-severity-pill" data-severity={severityTone(entry.severity)}>
                      {/^P\d$/i.test(entry.label) ? `${entry.count} 个 ${entry.label}` : `${entry.count} 个${entry.label}优先级`}
                    </span>
                  ))}
                </>
              ) : (
                <span className="na-team-severity-pill" data-severity="clean">未发现问题</span>
              )}
            </div>
          ) : null}

          {displayText ? (
            <div className="na-team-card-body markdown">
              <Suspense fallback={<p className="cli-plain">{displayText}</p>}>
                <RichText value={displayText} />
              </Suspense>
            </div>
          ) : null}

          {visibleFiles.length ? (
            <div className="na-team-files" aria-label="涉及文件">
              {visibleFiles.map((file) => (
                <span key={file} className="na-team-file">
                  <FileCode2 size={12} aria-hidden="true" />
                  <span>{file}</span>
                </span>
              ))}
              {hiddenFiles > 0 ? <span className="na-team-file">+{hiddenFiles} 个文件</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
