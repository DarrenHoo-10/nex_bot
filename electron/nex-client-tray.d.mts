export interface ClientTrayWindowLike {
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  restore?(): void;
  show(): void;
  hide(): void;
  focus(): void;
  setSkipTaskbar?(skip: boolean): void;
}

export interface ClientTrayDeviceState {
  available?: boolean;
  paused?: boolean;
}

export interface ClientTrayHandle {
  show(): boolean;
  refresh(): void;
  hide(win: ClientTrayWindowLike | null | undefined): boolean;
  isHidden(): boolean;
  windowShown(win: ClientTrayWindowLike | null | undefined): void;
  destroy(): void;
}

export function createClientTray(options: {
  Tray: new (...args: unknown[]) => {
    setToolTip(toolTip: string): void;
    setContextMenu(menu: unknown): void;
    on(event: string, listener: () => void): void;
    isDestroyed?(): boolean;
    destroy(): void;
  };
  Menu: { buildFromTemplate(template: Array<{ label?: string; type?: string; click?: () => void }>): unknown };
  nativeImage: { createFromPath(path: string): { resize(options: { width: number; height: number }): unknown } };
  iconPath: string;
  getWindow(): ClientTrayWindowLike | null | undefined;
  getDeviceState?(): ClientTrayDeviceState | null | undefined;
  onTogglePause?(paused: boolean): unknown;
  onQuit?(): void;
  platform?: string;
}): ClientTrayHandle;
