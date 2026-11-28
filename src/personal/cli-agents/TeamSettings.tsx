// Collaboration ("协作") preferences inside SettingsPage (design section 9.6).
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  cliPermissionLabel,
  cliPermissionModes,
  type CliEngine,
  type CliPermissionMode,
} from "../../../shared/cli-agents";
import { userErrorText } from "../../lib/http-errors";
import { fetchTeamSettings, saveTeamSettings } from "./api";
import { AGENT_LABEL } from "./session-model";
import { HarnessMark } from "./tokendance/HarnessMark";
import {
  DEFAULT_TEAM_SETTINGS,
  TEAM_DISPATCH_MODE_LABEL,
  type CliTeamDispatchMode,
  type CliTeamSettings,
} from "./team";

const DISPATCH_OPTIONS: Array<{ mode: CliTeamDispatchMode; hint: string }> = [
  { mode: "prompt", hint: "你在对话中提出协作后，由主会话自行拆解和派活" },
  { mode: "auto", hint: "主会话认为需要时，可主动开启协作并派活" },
  { mode: "off", hint: "禁止所有会话派活" },
];

const SUPPORTED_TEAM_ENGINES: readonly CliEngine[] = ["claude", "codex", "agy"];

export function TeamSettings({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<CliTeamSettings>(DEFAULT_TEAM_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let live = true;
    void fetchTeamSettings().then((next) => {
      if (!live) return;
      setSettings(next);
      setLoaded(true);
      setError("");
    }).catch(() => {
      if (live) setLoaded(true);
    });
    return () => { live = false; };
  }, [active]);

  async function update(patch: Partial<CliTeamSettings>) {
    const optimistic = { ...settings, ...patch };
    setSettings(optimistic);
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const next = await saveTeamSettings(patch);
      setSettings(next);
      setSaved(true);
    } catch (cause) {
      setError(userErrorText(cause, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="team-settings">
      <div className="preferences-panel-heading">
        <h2>协作</h2>
      </div>

      <section className="preferences-section">
        <div className="preferences-section-heading">
          <h3>派活方式</h3>
          {saved ? <span className="preferences-saved"><Check size={13} />已保存</span> : null}
          {!loaded ? <span className="preferences-status">加载中…</span> : null}
        </div>

        <div className="team-mode-group" role="radiogroup" aria-label="派活方式">
          {DISPATCH_OPTIONS.map(({ mode, hint }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={settings.dispatchMode === mode}
              className="team-mode-option"
              disabled={saving}
              onClick={() => void update({ dispatchMode: mode })}
            >
              <strong>{TEAM_DISPATCH_MODE_LABEL[mode]}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>

        <label className="field">
          单个主会话工人上限
          <select
            value={String(settings.maxWorkers)}
            disabled={saving}
            onChange={(event) => void update({ maxWorkers: Number(event.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 8, 10].map((count) => (
              <option key={count} value={count}>{count} 个工人</option>
            ))}
          </select>
        </label>

        <label className="preferences-toggle">
          <span>
            <strong>询问模式下默认放行 nex 命令</strong>
            <small>仅放行单条 nex 命令，不含管道、重定向或拼接语句。</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.allowNexInAsk}
            disabled={saving}
            onChange={(event) => void update({ allowNexInAsk: event.target.checked })}
          />
        </label>
      </section>

      <section className="preferences-section">
        <div className="preferences-section-heading">
          <h3>可用 Agent 与默认权限</h3>
        </div>
        <div className="team-engine-list">
          {SUPPORTED_TEAM_ENGINES.map((engine) => {
            const installed = settings.installedEngines.includes(engine);
            const enabled = settings.enabledEngines.includes(engine);
            const modes = cliPermissionModes(engine);
            const perm = settings.defaultPermissions[engine] ?? "default";
            return (
              <div key={engine} className="team-engine-row">
                <div className="team-engine-info">
                  <HarnessMark agentId={engine} size="sm" />
                  <strong>{AGENT_LABEL[engine]}</strong>
                  <span className="team-engine-installed">{installed ? "已安装" : "未检测到"}</span>
                </div>
                <select
                  aria-label={`${AGENT_LABEL[engine]} 默认权限`}
                  value={perm}
                  disabled={saving || !enabled}
                  onChange={(event) => void update({
                    defaultPermissions: {
                      ...settings.defaultPermissions,
                      [engine]: event.target.value as CliPermissionMode | "default",
                    },
                  })}
                >
                  <option value="default">跟随引擎默认</option>
                  {modes.map((mode) => (
                    <option key={mode} value={mode}>{cliPermissionLabel(engine, mode)}</option>
                  ))}
                </select>
                <label className="device-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`允许派给 ${AGENT_LABEL[engine]}`}
                    checked={enabled}
                    disabled={saving || !installed}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...new Set([...settings.enabledEngines, engine])]
                        : settings.enabledEngines.filter((entry) => entry !== engine);
                      void update({ enabledEngines: next });
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>
      </section>

      <section className="preferences-section">
        <div className="preferences-section-heading">
          <h3>安全上限</h3>
        </div>
        <dl className="preferences-facts">
          <div><dt>派活层级</dt><dd>单层（工人不能再派活，可使用自身子代理）</dd></div>
          <div><dt>协作消息上限</dt><dd>每小时 {settings.limits.mailPerHour} 条</dd></div>
          <div><dt>空闲自动暂停</dt><dd>{settings.limits.idlePauseHours} 小时</dd></div>
          <div><dt>启动失败熔断</dt><dd>同一任务连续失败 {settings.limits.circuitBreakerFailures} 次</dd></div>
        </dl>
        {error ? <p className="preferences-notice" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
