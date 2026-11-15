import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronsUpDown, Monitor } from "lucide-react";
import type { CliDeviceView } from "../../../shared/cli-agents";

interface Props {
  devices: readonly CliDeviceView[];
  value: string;
  disabled: boolean;
  onChange(id: string): void;
}

function Status({ online }: { online: boolean }) {
  return <span className="na-device-status" data-online={online}>{online ? "在线" : "离线"}</span>;
}

export function LaunchDevicePicker({ devices, value, disabled, onChange }: Props) {
  const listId = useId();
  const labelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(value);
  const device = devices.find(entry => entry.id === value);
  const expanded = open && !disabled && devices.length > 0;
  const active = Math.max(0, devices.findIndex(entry => entry.id === activeId));

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded]);

  useEffect(() => {
    if (expanded) document.getElementById(listId + active)?.scrollIntoView({ block: "nearest" });
  }, [active, expanded, listId]);

  function expand() {
    setActiveId(value);
    setOpen(true);
  }

  function choose(id: string) {
    setOpen(false);
    if (id !== value) onChange(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && expanded) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { expand(); return; }
      let index = active;
      if (event.key === "Home") index = 0;
      if (event.key === "End") index = devices.length - 1;
      if (event.key === "ArrowUp") index = Math.max(0, index - 1);
      if (event.key === "ArrowDown") index = Math.min(devices.length - 1, index + 1);
      setActiveId(devices[index].id);
    } else if (expanded && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choose(devices[active].id);
    }
  }

  return <div className="cli-field na-device-field" ref={root}>
    <span id={labelId}>设备</span>
    <div className="na-device-surface" data-expanded={expanded}>
      <button type="button" role="combobox" aria-labelledby={labelId} aria-controls={listId}
        aria-expanded={expanded} aria-haspopup="listbox" aria-activedescendant={expanded ? listId + active : undefined}
        className="na-device-trigger" disabled={disabled || !devices.length}
        onClick={() => expanded ? setOpen(false) : expand()} onKeyDown={onKeyDown} onBlur={() => setOpen(false)}>
        <span className="na-device-glyph"><Monitor size={19} strokeWidth={1.65}/></span>
        <span className="na-device-name">{device?.name ?? (devices.length ? "选择设备" : "暂无设备")}</span>
        {device && <Status online={device.online}/>}
        {devices.length > 0 && <ChevronsUpDown className="na-device-arrows" size={14}/>}
      </button>
      <div id={listId} role="listbox" aria-labelledby={labelId} hidden={!expanded} className="na-device-list">
        {expanded && devices.map((entry, index) =>
          <div id={listId + index} key={entry.id} role="option" aria-selected={entry.id === value}
            data-active={index === active} className="na-device-option"
            onMouseDown={event => event.preventDefault()} onClick={() => choose(entry.id)}>
            <Monitor size={15} strokeWidth={1.65}/>
            <span className="na-device-name">{entry.name}</span>
            <Status online={entry.online}/>
            <span className="na-device-tick">{entry.id === value && <Check size={15}/>}</span>
          </div>)}
      </div>
    </div>
  </div>;
}
