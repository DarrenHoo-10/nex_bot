// Collaboration runs ("协作") state: initial HTTP snapshot, updates on stream
// reconnect/reload, and direct control mutations (pause/resume/cancel/stop).
import { useCallback, useEffect, useMemo, useState } from "react";
import { cancelTeam, fetchTeams, pauseTeam, resumeTeam, stopTeamWorker } from "./api";
import type { CliStream } from "./stream";
import { indexTeams, type CliTeamRunView, type TeamIndex } from "./team";

export interface UseCliTeamsResult {
  runs: readonly CliTeamRunView[];
  index: TeamIndex;
  refresh(): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  stopWorker(runId: string, workerName: string): Promise<void>;
}

function mergeRun(current: readonly CliTeamRunView[], updated: CliTeamRunView | null): CliTeamRunView[] {
  if (!updated) return [...current];
  const exists = current.some((run) => run.id === updated.id);
  return exists ? current.map((run) => (run.id === updated.id ? updated : run)) : [updated, ...current];
}

export function useCliTeams(stream: CliStream, loaded: boolean, reloadToken: number): UseCliTeamsResult {
  const [runs, setRuns] = useState<CliTeamRunView[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchTeams();
      setRuns(next);
    } catch {
      // Older Cores without /api/cli-agents/teams leave collaboration empty.
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let live = true;
    const read = () => {
      void fetchTeams().then((next) => {
        if (live) setRuns(next);
      }, () => undefined);
    };
    read();
    const off = stream.on((event) => {
      if (event.type === "status" && event.status === "open") {
        read();
        return;
      }
      if (event.type !== "message") return;
      if (event.message.type === "cli.team") {
        if (event.message.runs) {
          setRuns(event.message.runs);
        } else if (event.message.run) {
          const updated = event.message.run;
          setRuns((current) => mergeRun(current, updated));
        }
        return;
      }
      if (event.message.type === "list") {
        read();
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [stream, loaded, reloadToken]);

  const pause = useCallback(async (runId: string) => {
    const updated = await pauseTeam(runId);
    if (updated) setRuns((current) => mergeRun(current, updated));
    else await refresh();
  }, [refresh]);

  const resume = useCallback(async (runId: string) => {
    const updated = await resumeTeam(runId);
    if (updated) setRuns((current) => mergeRun(current, updated));
    else await refresh();
  }, [refresh]);

  const cancel = useCallback(async (runId: string) => {
    const updated = await cancelTeam(runId);
    if (updated) setRuns((current) => mergeRun(current, updated));
    else await refresh();
  }, [refresh]);

  const stopWorker = useCallback(async (runId: string, workerName: string) => {
    const updated = await stopTeamWorker(runId, workerName);
    if (updated) setRuns((current) => mergeRun(current, updated));
    else await refresh();
  }, [refresh]);

  const index = useMemo(() => indexTeams(runs), [runs]);
  return { runs, index, refresh, pause, resume, cancel, stopWorker };
}
