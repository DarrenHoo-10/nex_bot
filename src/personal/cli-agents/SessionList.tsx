// Sessions grouped by computer, then by folder.
import { Eye, EyeOff, Plus } from "lucide-react";
import type { CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { ENGINE_LABEL, sessionStatusLabel, sessionTitle, sessionTone, type DeviceGroup } from "./session-model";

export interface SessionListProps {
  groups: readonly DeviceGroup[];
  selectedKey: CliSessionKey | null;
  hiddenTotal: number;
  showHidden: boolean;
  onSelect(key: CliSessionKey): void;
  onNew(deviceId: string): void;
  onHide(session: CliSessionView, hidden: boolean): void;
  onToggleHidden(): void;
}

export function SessionList({ groups, selectedKey, hiddenTotal, showHidden, onSelect, onNew, onHide, onToggleHidden }: SessionListProps) {
  return (
    <nav className="cli-list" aria-label="Agent 会话">
      {groups.map(({ device, folders, count }) => (
        <section key={device.id} className="cli-device" data-online={device.online ? "1" : "0"}>
          <header>
            <span className="cli-dot" aria-hidden="true" />
            <strong title={device.name}>{device.name}</strong>
            <small>{device.online ? count : "离线"}</small>
            <button type="button" className="icon-button" aria-label={`在 ${device.name} 上新建会话`} title="新建会话" onClick={() => onNew(device.id)}><Plus size={15} /></button>
          </header>
          {folders.map((folder) => (
            <div key={folder.cwd} className="cli-folder">
              <div className="cli-folder-name" title={folder.cwd}>{folder.label}</div>
              {folder.sessions.map((session) => (
                <div key={session.key} className={`cli-row ${session.key === selectedKey ? "is-selected" : ""} ${session.hidden ? "is-hidden" : ""}`}>
                  <button type="button" className="cli-row-main" aria-current={session.key === selectedKey ? "true" : undefined} onClick={() => onSelect(session.key)}>
                    <span className="cli-row-title">{sessionTitle(session)}</span>
                    <span className="cli-row-meta">
                      <span className="cli-chip" data-tone={sessionTone(session)}>{sessionStatusLabel(session)}</span>
                      <small>{ENGINE_LABEL[session.engine]}</small>
                    </span>
                  </button>
                  <button type="button" className="icon-button cli-row-hide" aria-label={session.hidden ? "取消隐藏" : "隐藏"} title={session.hidden ? "取消隐藏" : "隐藏"} onClick={() => onHide(session, !session.hidden)}>
                    {session.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                </div>
              ))}
            </div>
          ))}
          {count === 0 ? <div className="cli-device-empty">暂无会话</div> : null}
        </section>
      ))}
      {hiddenTotal > 0 ? <button type="button" className="text-button cli-hidden-toggle" aria-pressed={showHidden} onClick={onToggleHidden}>{showHidden ? "收起已隐藏" : `已隐藏 ${hiddenTotal}`}</button> : null}
    </nav>
  );
}
