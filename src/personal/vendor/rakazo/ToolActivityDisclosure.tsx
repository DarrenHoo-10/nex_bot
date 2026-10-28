// Adapted from Rakazo 6191ad23, apps/web/src/components/ToolActivityDisclosure.tsx.
// Apache-2.0. Changes: local styling, Chinese labels, truthful terminal label, glass summary pill.
import { BookOpen, Brain, ChevronDown, Clock, Code2, FolderOpen, Image as ImageIcon, Monitor, Paperclip, Plug, SquareTerminal, Users, Wrench, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const kinds: Array<[RegExp, LucideIcon]> = [[/^memory\./, Brain], [/^device\.exec$/, SquareTerminal], [/^device\.computer$/, Monitor], [/^device\./, FolderOpen], [/^connector\./, Plug], [/^agent\./, Users], [/^routine\./, Clock], [/^image\./, ImageIcon], [/^html\./, Code2], [/^skill\./, BookOpen], [/^attachment\./, Paperclip]];
const iconOf = (tool: string) => kinds.find(([pattern]) => pattern.test(tool))?.[1] ?? Wrench;

export function ToolActivityDisclosure({ live, stepCount, steps = [], children }: { live: boolean; stepCount: number; steps?: Array<{ tool_name: string; status: string }>; children: ReactNode }) {
  const icons = [...new Set(steps.map((step) => iconOf(step.tool_name)))].slice(0, 3), failed = steps.filter((step) => step.status === "failed").length;
  return <details key={live ? "working" : "actions"} open={live} data-testid="tool-activity" data-live={live || undefined} className="tool-activity-disclosure">
    <summary className="glass">
      {icons.length ? <span className="tool-chips" aria-hidden="true">{icons.map((Icon, index) => <span key={index}><Icon size={13} strokeWidth={2}/></span>)}</span> : null}
      <span>{live ? "正在执行 · " : ""}{stepCount} 项操作</span>
      {failed ? <span className="tool-failed">· {failed} 项失败</span> : null}
      <ChevronDown className="tool-chevron" aria-hidden size={13}/>
    </summary>
    <div className="tool-activity-content">{children}</div>
  </details>;
}
