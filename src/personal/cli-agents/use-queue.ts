// The outbox of the open session, from the stream: Core pushes one session's
// queue on subscribe and on every change (workbench plan section 3). The
// snapshot also arrives over HTTP, so a reconnect heals from `fetchQueue`.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { fetchQueue, type CliQueue, type CliQueueEntry } from "./api";
import type { CliStream } from "./stream";

export const isVisibleQueueEntry = (entry: CliQueueEntry) => entry.status === "pending" || entry.status === "uncertain" || entry.status === "failed";

export function useCliQueue(stream: CliStream, sessionKey: CliSessionKey) {
  const [queue, setQueue] = useState<CliQueue | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    setQueue(null);
    let live = true;
    let revision = 0;
    refresh.current = async () => {
      const requested = ++revision;
      try {
        const snapshot = await fetchQueue(sessionKey);
        if (live && revision === requested) setQueue(snapshot);
      } catch { /* the stream can still deliver the current queue */ }
    };
    const off = stream.on((event) => {
      if (event.type !== "message" || event.message.type !== "queue" || event.message.queue.sessionKey !== sessionKey) return;
      revision++;
      setQueue(event.message.queue);
    });
    const release = stream.subscribeSession(sessionKey);
    void refresh.current();
    return () => {
      live = false;
      off();
      release();
    };
  }, [stream, sessionKey]);
  const refreshQueue = useCallback(() => refresh.current(), []);
  return { queue, refreshQueue };
}
