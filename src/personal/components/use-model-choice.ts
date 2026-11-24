import { useRef, useState } from "react";
import { api, type Connection, type ReasoningChoice, type RecordRow, type State } from "../api";
import type { ModelChoice } from "./ModelMenu";

interface Selection {
  selected_connection: string;
  selected_model: string;
  selected_reasoning: ReasoningChoice | null;
  model_selection_version: number;
}

const fromSelection = (row: Selection): ModelChoice => ({
  connectionId: row.selected_connection,
  model: row.selected_model,
  reasoning: row.selected_reasoning,
});

export function useModelChoice(botId: string, bot: RecordRow | undefined, fallback: ModelChoice, connections: readonly Connection[]) {
  const queued = useRef(new Map<string, ModelChoice>());
  const [saved, setSaved] = useState<Record<string, Selection>>({});
  const [pending, setPending] = useState<Record<string, ModelChoice | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const version = Number(bot?.model_selection_version ?? 0);
  const confirmed = saved[botId];
  const newer = confirmed && confirmed.model_selection_version > version &&
    connections.some((connection) => connection.id === confirmed.selected_connection && connection.enabled) ? confirmed : undefined;

  async function choose(next: ModelChoice) {
    const queue = queued.current;
    const alreadySaving = queue.has(botId);
    queue.set(botId, next);
    setPending((all) => ({ ...all, [botId]: next }));
    setErrors((all) => ({ ...all, [botId]: "" }));
    if (alreadySaving) return;

    let currentVersion = newer?.model_selection_version ?? version;
    try {
      let choice = next;
      while (true) {
        const result = await api<{ selection?: Selection }>("bots/model", {
          id: botId, connectionId: choice.connectionId, model: choice.model,
          ...(choice.reasoning ? { reasoning: choice.reasoning } : {}), version: currentVersion,
        });
        // Older Cores return only `ok`; read the new version before a second write.
        let selection = result.selection;
        if (!selection) {
          const row = (await api<State>("state?view=summary")).bots.find((row) => row.id === botId);
          if (!row || typeof row.model_selection_version !== "number") throw new Error("无法确认模型设置");
          selection = {
            selected_connection: String(row.selected_connection ?? ""),
            selected_model: String(row.selected_model ?? ""),
            selected_reasoning: (row.selected_reasoning ?? null) as ReasoningChoice | null,
            model_selection_version: row.model_selection_version,
          };
        }
        currentVersion = selection.model_selection_version;
        setSaved((all) => ({ ...all, [botId]: selection }));
        const latest = queue.get(botId);
        if (!latest || latest === choice) break;
        choice = latest;
      }
    } catch (error) {
      setErrors((all) => ({ ...all, [botId]: error instanceof Error ? error.message : "保存模型失败" }));
    } finally {
      queue.delete(botId);
      setPending((all) => ({ ...all, [botId]: undefined }));
    }
  }

  return {
    choice: pending[botId] ?? (newer ? fromSelection(newer) : fallback),
    saving: !!pending[botId],
    isSaving: () => queued.current.has(botId),
    error: errors[botId],
    dismissError: () => setErrors((all) => ({ ...all, [botId]: "" })),
    choose,
  };
}
