// Adapted from Rakazo 6191ad23, apps/web/src/components/ToolActivityDisclosure.tsx.
// Apache-2.0. Changes: local styling, Chinese labels, truthful terminal label.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function ToolActivityDisclosure({ live, stepCount, children }: { live: boolean; stepCount: number; children: ReactNode }) {
  return <details key={live ? "working" : "actions"} open={live} data-testid="tool-activity" data-live={live || undefined} className="tool-activity-disclosure">
    <summary><ChevronRight aria-hidden size={14} strokeWidth={1.8}/><span>{live ? "正在执行" : "执行记录"} · {stepCount} 项操作</span></summary>
    <div className="tool-activity-content">{children}</div>
  </details>;
}
