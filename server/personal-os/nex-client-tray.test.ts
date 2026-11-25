import { describe, expect, it, vi } from "vitest";
import { createClientTray } from "../../electron/nex-client-tray.mjs";
import { activateExistingWindow } from "../../electron/single-instance.mjs";

function makeHarness(initialState = { available: false, paused: false }, platform = "win32") {
  let state = { ...initialState };
  const listeners = new Map<string, Array<() => void>>();
  let tooltip = "";
  let menuTemplate: Array<{ label?: string; type?: string; click?: () => void }> = [];
  let destroyed = false;
  let trayCtorArgs: unknown[] = [];

  class FakeTray {
    constructor(...args: unknown[]) {
      trayCtorArgs = args;
    }
    setToolTip(next: string) {
      tooltip = next;
    }
    setContextMenu(menu: typeof menuTemplate) {
      menuTemplate = menu;
    }
    on(event: string, fn: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    }
    isDestroyed() {
      return destroyed;
    }
    destroy() {
      destroyed = true;
    }
  }

  const win = {
    destroyed: false,
    minimized: false,
    visible: true,
    skipTaskbar: false,
    focused: false,
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isFocused() {
      return this.focused;
    },
    restore: vi.fn(function (this: typeof win) {
      this.minimized = false;
    }),
    show: vi.fn(function (this: typeof win) {
      this.visible = true;
    }),
    hide: vi.fn(function (this: typeof win) {
      this.visible = false;
    }),
    focus: vi.fn(function (this: typeof win) {
      this.focused = true;
    }),
    setSkipTaskbar: vi.fn(function (this: typeof win, flag: boolean) {
      this.skipTaskbar = flag;
    }),
  };

  const onTogglePause = vi.fn();
  const onQuit = vi.fn();
  const tray = createClientTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items: typeof menuTemplate) => items },
    nativeImage: { createFromPath: (p: string) => ({ resize: (opts: { width: number; height: number }) => ({ path: p, ...opts }) }) },
    iconPath: "/icon.png",
    getWindow: () => win,
    getDeviceState: () => state,
    onTogglePause,
    onQuit,
    platform,
  });

  return {
    tray,
    win,
    onTogglePause,
    onQuit,
    setState(next: typeof state) {
      state = next;
      tray.refresh();
    },
    tooltip: () => tooltip,
    menu: () => menuTemplate,
    ctorArgs: () => trayCtorArgs,
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    isDestroyed: () => destroyed,
  };
}

describe("NexBot client system tray", () => {
  it("hides to tray and restores on click or double-click with taskbar visibility synced", () => {
    const h = makeHarness();
    expect(h.ctorArgs()).toHaveLength(2);
    expect(h.tray.isHidden()).toBe(false);

    expect(h.tray.hide(h.win)).toBe(true);
    expect(h.tray.isHidden()).toBe(true);
    expect(h.win.visible).toBe(false);
    expect(h.win.skipTaskbar).toBe(true);

    h.win.minimized = true;
    h.emit("click");
    expect(h.tray.isHidden()).toBe(false);
    expect(h.win.minimized).toBe(false);
    expect(h.win.visible).toBe(true);
    expect(h.win.skipTaskbar).toBe(false);
    expect(h.win.focus).toHaveBeenCalledTimes(1);

    h.tray.hide(h.win);
    expect(activateExistingWindow([h.win])).toBe(true);
    expect(h.win.skipTaskbar).toBe(false);
    expect(h.win.visible).toBe(true);
  });

  it("shows pause/resume control only when logged in and updates tooltip", () => {
    const h = makeHarness({ available: false, paused: false });
    expect(h.menu().map((item) => item.label ?? item.type)).toEqual(["打开 NexBot", "separator", "退出 NexBot"]);
    expect(h.tooltip()).toBe("NexBot");

    h.setState({ available: true, paused: false });
    expect(h.menu().map((item) => item.label ?? item.type)).toEqual(["打开 NexBot", "暂停本机控制", "separator", "退出 NexBot"]);
    h.menu()[1].click?.();
    expect(h.onTogglePause).toHaveBeenCalledWith(true);

    h.setState({ available: true, paused: true });
    expect(h.menu().map((item) => item.label ?? item.type)).toEqual(["打开 NexBot", "恢复本机控制", "separator", "退出 NexBot"]);
    expect(h.tooltip()).toBe("NexBot · 已暂停本机控制");
    h.menu()[1].click?.();
    expect(h.onTogglePause).toHaveBeenCalledWith(false);

    h.menu().at(-1)?.click?.();
    expect(h.onQuit).toHaveBeenCalledTimes(1);

    h.tray.destroy();
    expect(h.isDestroyed()).toBe(true);
  });
});
