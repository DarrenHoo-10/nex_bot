export interface ClientUpdateSnapshot {
  status: string;
  current: string;
  version?: string;
  progress?: number;
  error?: string;
  notes?: string;
}

export class ClientUpdater {
  status: string;
  busy: boolean;
  file?: string;
  constructor(options: {
    version: string;
    directory: string;
    fetch?: typeof fetch;
    changed?: (state: ClientUpdateSnapshot) => void;
  });
  state(): ClientUpdateSnapshot;
  set(status: string, extra?: Partial<ClientUpdateSnapshot>): void;
  check(origin: string): Promise<ClientUpdateSnapshot>;
}

export interface InstallerLauncherProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): unknown;
}

export function runInstallerAfterExit(options: {
  downloaded: string;
  currentExe: string;
  pid: number;
  args: string[];
  launch?: (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: "ignore"; windowsHide: boolean },
  ) => InstallerLauncherProcess;
  timeoutMs?: number;
}): Promise<void>;
