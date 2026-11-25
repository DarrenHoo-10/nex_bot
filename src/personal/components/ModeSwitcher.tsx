// The brand in the top-left corner doubles as the switch between the assistants (NexBot)
// and the coding agents running on the user's computers (NexAgent): clicking it goes straight to the other one.
import { BrandMark } from "./BrandMark";

export type WorkspaceMode = "bot" | "agent";

interface Props {
  mode: WorkspaceMode;
  /** Agent sessions waiting for the user */
  waiting: number;
  onMode(mode: WorkspaceMode): void;
}

export const MODE_LABEL: Record<WorkspaceMode, string> = { bot: "NexBot", agent: "NexAgent" };

export function ModeSwitcher({ mode, waiting, onMode }: Props) {
  const next: WorkspaceMode = mode === "agent" ? "bot" : "agent";
  const badge = mode === "bot" && waiting > 0;
  const label = `切换到 ${MODE_LABEL[next]}${badge ? `，${waiting} 个等你处理` : ""}`;
  return <div className="mode-switcher">
    <button type="button" className="mode-switcher-button" data-mode={mode} aria-label={label} title={`切换到 ${MODE_LABEL[next]}`} onClick={() => onMode(next)}>
      <BrandMark size={30} agent={mode === "agent"}/>
      <strong>{MODE_LABEL[mode]}</strong>
      {badge ? <span className="contact-unread mode-switcher-badge" data-testid="cli-waiting">{waiting > 99 ? "99+" : waiting}</span> : null}
    </button>
  </div>;
}
