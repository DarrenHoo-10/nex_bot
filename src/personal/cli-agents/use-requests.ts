// The request cards' state: pushes from the stream, the pending list of the
// first HTTP read, and what this page answered.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CliRequestView, CliSessionKey } from "../../../shared/cli-agents";
import { dropOpen, EMPTY_STORE, markAnswered, mergePending, nextExpiry, resolveRequest, setPending, type RequestStore } from "./requests";
import type { CliStream } from "./stream";

export function useCliRequests(stream: CliStream) {
  const [store, setStore] = useState<RequestStore>(EMPTY_STORE);
  const [tick, setTick] = useState(0);

  useEffect(() => stream.on((event) => {
    if (event.type !== "message") return;
    const message = event.message;
    if (message.type === "list") setStore(dropOpen);
    else if (message.type === "requests") setStore((current) => setPending(current, message.key, message.requests));
    else if (message.type === "request.resolved") setStore((current) => resolveRequest(current, message.key, message.id, message.by));
  }), [stream]);

  // the clock only moves when a card is about to expire, or the store changed
  const now = useMemo(() => Date.now(), [store, tick]);
  const expiry = useMemo(() => nextExpiry(store, now), [store, now]);
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, expiry - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [expiry]);

  const merge = useCallback((views: readonly CliRequestView[]) => setStore((current) => mergePending(current, views)), []);
  const answered = useCallback((key: CliSessionKey, id: string, decision: "allow" | "deny", always?: boolean) => setStore((current) => markAnswered(current, key, id, decision, always)), []);
  return { store, now, merge, answered };
}
