// The outbox of the open session, from the stream: Core pushes one session's
// queue on subscribe and on every change (workbench plan section 3). The
// snapshot also arrives over HTTP, so a reconnect heals from `fetchQueue`.
import { useEffect, useState } from "react";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { fetchQueue, type CliQueue } from "./api";
import type { CliStream } from "./stream";

export function useCliQueue(stream: CliStream, sessionKey: CliSessionKey | null): CliQueue | null {
  const [queue, setQueue] = useState<CliQueue | null>(null);
  useEffect(() => {
    setQueue(null);
    if (!sessionKey) return;
    let live = true;
    const release = stream.subscribeSession(sessionKey);
    const off = stream.on((event) => {
      if (event.type !== "message" || event.message.type !== "queue" || event.message.queue.sessionKey !== sessionKey) return;
      if (live) setQueue(event.message.queue);
    });
    // a queue that already exists shows up without waiting for a change
    void fetchQueue(sessionKey).then((snapshot) => {
      if (live && (snapshot.entries.length || snapshot.paused)) setQueue((current) => current ?? snapshot);
    }, () => undefined);
    return () => {
      live = false;
      off();
      release();
    };
  }, [stream, sessionKey]);
  return queue;
}
