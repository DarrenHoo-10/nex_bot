// System tray controller for the NexBot desktop client, kept Electron-free so
// lifecycle and menu rules stay unit-testable with plain object fakes.
const WIN_TRAY_GUID = "c6d91b40-7f24-4e8a-9b3e-2d1a8f5e0c42";

export function createClientTray({
  Tray,
  Menu,
  nativeImage,
  iconPath,
  getWindow,
  getDeviceState = () => ({ available: false }),
  onTogglePause = () => {},
  onQuit = () => {},
  platform = process.platform,
}) {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  const tray = platform === "win32" ? new Tray(image, WIN_TRAY_GUID) : new Tray(image);
  let hidden = false;

  const show = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    hidden = false;
    win.setSkipTaskbar?.(false);
    if (win.isMinimized?.()) win.restore();
    win.show();
    win.focus();
    return true;
  };

  const refresh = () => {
    if (tray.isDestroyed?.()) return;
    const state = getDeviceState() ?? { available: false };
    const items = [{ label: "打开 NexBot", click: show }];
    if (state.available) {
      const nextPaused = !state.paused;
      items.push({
        label: state.paused ? "恢复本机控制" : "暂停本机控制",
        click: () => { void onTogglePause(nextPaused); },
      });
    }
    items.push({ type: "separator" }, { label: "退出 NexBot", click: onQuit });
    tray.setToolTip(state.available && state.paused ? "NexBot · 已暂停本机控制" : "NexBot");
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };

  refresh();
  tray.on("click", show);
  tray.on("double-click", show);

  return {
    show,
    refresh,
    hide(win) {
      if (!win || win.isDestroyed()) return false;
      hidden = true;
      win.setSkipTaskbar?.(true);
      win.hide();
      return true;
    },
    isHidden() {
      return hidden;
    },
    windowShown(win) {
      hidden = false;
      win?.setSkipTaskbar?.(false);
    },
    destroy() {
      if (!tray.isDestroyed?.()) tray.destroy();
    },
  };
}
