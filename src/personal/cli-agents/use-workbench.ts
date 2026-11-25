// The logical session tree (workbench plan section 3): one HTTP snapshot,
// then whole-tree pushes from the stream. Renames, forks and deletes are rare,
// so a full snapshot per change is fine and keeps the parents correct.
import { useEffect, useState } from "react";
import { fetchSnapshotWithWorkbench, parseWorkbenchRows, type CliWorkbenchSession } from "./api";
import type { CliStream } from "./stream";

export function useWorkbenchTree(stream: CliStream, loaded: boolean, reloadToken: number): CliWorkbenchSession[] {
  const [tree, setTree] = useState<CliWorkbenchSession[]>([]);
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    const read = () => {
      void fetchSnapshotWithWorkbench().then((snapshot) => {
        if (live) setTree(parseWorkbenchRows(snapshot?.workbench));
      }, () => undefined);
    };
    read();
    const off = stream.on((event) => {
      if (event.type === "message" && event.message.type === "workbench") {
        setTree(parseWorkbenchRows(event.message.sessions));
        return;
      }
      if (event.type === "status" && event.status === "open") read();
    });
    return () => {
      live = false;
      off();
    };
  }, [stream, loaded, reloadToken]);
  return tree;
}

/** By logical id, with the display title a row carries. */
export function workbenchIndex(tree: readonly CliWorkbenchSession[]): Map<string, CliWorkbenchSession> {
  return new Map(tree.map((row) => [row.id, row]));
}
