// Sessions grouped by computer, then by folder.
import { Eye, EyeOff, Plus } from "lucide-react";
import type { CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { askedSession, ENGINE_LABEL, sessionStatusLabel, sessionTitle, sessionTone, type DeviceGroup } from "./session-model";

export interface SessionListProps {
  groups: readonly DeviceGroup[];
  selectedKey: CliSessionKey | null;
  /** pending requests per session */
  pending?: ReadonlyMap<string, number>;
  hiddenTotal: number;
  showHidden: boolean;
  onSelect(key: CliSessionKey): void;
  onNew(deviceId: string): void;
  onHide(session: CliSessionView, hidden: boolean): void;
  onToggleHidden(): void;
}

export function SessionList({ groups, selectedKey, pending, hiddenTotal, showHidden, onSelect, onNew, onHide, onToggleHidden }: SessionListProps) {
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
              {folder.sessions.map((entry) => {
                const asked = pending?.get(entry.key) ?? 0;
                // a pending request means the session waits for the user, whatever its own state says
                const session = askedSession(entry, asked);
                return (
                  <div key={entry.key} className={`cli-row ${entry.key === selectedKey ? "is-selected" : ""} ${entry.hidden ? "is-hidden" : ""}`}>
                    <button type="button" className="cli-row-main" aria-current={entry.key === selectedKey ? "true" : undefined} onClick={() => onSelect(entry.key)}>
                      <span className="cli-row-title">{sessionTitle(entry)}</span>
                      <span className="cli-row-meta">
                        <span className="cli-chip" data-tone={sessionTone(session)}>{sessionStatusLabel(session)}</span>
                        {asked > 0 ? <span className="cli-count" role="img" aria-label={`${asked} 个请求`} title={`${asked} 个请求`}>{asked}</span> : null}
                        <small>{ENGINE_LABEL[entry.engine]}</small>
                      </span>
                    </button>
                    <button type="button" className="icon-button cli-row-hide" aria-label={entry.hidden ? "取消隐藏" : "隐藏"} title={entry.hidden ? "取消隐藏" : "隐藏"} onClick={() => onHide(entry, !entry.hidden)}>
                      {entry.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {count === 0 ? <div className="cli-device-empty">暂无会话</div> : null}
        </section>
      ))}
      {hiddenTotal > 0 ? <button type="button" className="text-button cli-hidden-toggle" aria-pressed={showHidden} onClick={onToggleHidden}>{showHidden ? "收起已隐藏" : `已隐藏 ${hiddenTotal}`}</button> : null}
    </nav>
  );
}
