import { useRef, useState, type CSSProperties } from "react";

export function EffortChoices<Level extends string>({ levels, value, label, onChange, disabled }: {
  levels: readonly Level[]; value: Level | undefined; label: (level: Level) => string;
  onChange: (level: Level) => void; disabled?: boolean;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const dragging = useRef(false);
  const last = levels.length - 1;
  const confirmed = value === undefined ? -1 : levels.indexOf(value);
  const position = Math.max(0, Math.min(last, preview ?? confirmed));
  const current = preview === null ? confirmed : Math.round(position);
  const text = current < 0 ? "默认" : label(levels[current]);
  const commit = (index: number) => {
    dragging.current = false;
    setPreview(null);
    const next = levels[Math.max(0, Math.min(last, Math.round(index)))];
    if (next !== undefined && next !== value) onChange(next);
  };

  return <div className="model-menu-effort" data-dragging={preview !== null || undefined} role="group" aria-label="思考强度"
    style={{ "--effort-progress": last > 0 ? position / last : 0 } as CSSProperties}>
    <div className="model-menu-effort-label"><span>思考强度</span><strong>{text}</strong></div>
    {last > 0 && <div className="model-menu-effort-slider">
      <input type="range" min={0} max={last} step="any" value={position} disabled={disabled}
        aria-label="思考强度" aria-valuetext={text}
        onPointerDown={() => { dragging.current = true; setPreview(position); }}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (dragging.current) setPreview(next);
          else commit(next);
        }}
        onPointerUp={(event) => { if (dragging.current) commit(event.currentTarget.valueAsNumber); }}
        onPointerCancel={() => { dragging.current = false; setPreview(null); }}
        onKeyDown={(event) => {
          const steps: Record<string, number> = {
            ArrowLeft: position - 1, ArrowDown: position - 1,
            ArrowRight: position + 1, ArrowUp: position + 1,
            PageUp: position + 1, PageDown: position - 1,
            Home: 0, End: last,
          };
          if (!(event.key in steps)) return;
          event.preventDefault();
          commit(steps[event.key]);
        }}/>
      <div className="model-menu-effort-track" aria-hidden="true"><i/><b/></div>
    </div>}
    <div className="model-menu-stops">
      {levels.map((level, index) => <button type="button" key={level} disabled={disabled}
        aria-pressed={current === index} onClick={() => commit(index)}>{label(level)}</button>)}
    </div>
  </div>;
}
