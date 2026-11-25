export interface SingleInstanceWindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  setSkipTaskbar?(skip: boolean): void;
}

export function activateExistingWindow(windows: ReadonlyArray<SingleInstanceWindowLike | null | undefined>): boolean;
export function releaseSingleInstanceLock(app: { hasSingleInstanceLock(): boolean; releaseSingleInstanceLock(): void }): boolean;
