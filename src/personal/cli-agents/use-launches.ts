// New sessions started from the new-session dialog. The dialog closes at once:
// the session shows in the list and the pane with the user's first message while
// the computer builds the worktree and starts the CLI, and the message is sent as
// soon as the session exists. A failure stays on the row with a retry.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CliEngine, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { CliApiError, cliErrorText, sendMessage, startSession } from "./api";
import type { LaunchChoice } from "./CliModelMenu";
import { saveLaunch } from "./composer-additions";
import { useReview } from "./WorkbenchReview";

export interface LaunchRequest {
  deviceId: string;
  engine: CliEngine;
  cwd: string;
  /** a new worktree on this branch; absent runs in `cwd` itself */
  branch?: string;
  /** the first message; may be empty */
  message: string;
  choice: LaunchChoice;
}

export type LaunchPhase = "starting" | "sending" | "sent" | "failed";

export interface Launch extends LaunchRequest {
  id: string;
  /** the placeholder's key in the list until the real session shows up */
  key: CliSessionKey;
  createdAt: number;
  phase: LaunchPhase;
  error?: string;
  /** the started session */
  target?: CliSessionKey;
}

/** A first message the real session's pane shows until its transcript has it. */
export interface LaunchEcho { text: string; at: number }

/** Ids that make a retry the same request: the device reuses the worktree, Core the message. */
interface Attempt { requestId: string; clientMessageId: string; sendRequestId: string }

const LAUNCH_PREFIX = "launch-";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isLaunchKey(key: string | null | undefined): boolean {
  return !!key && key.split(":")[2]?.startsWith(LAUNCH_PREFIX) === true;
}

/** The list row a launch shows as until its session is listed. */
export function launchRow(launch: Launch): CliSessionView {
  const title = launch.message.trim().split("\n")[0]?.slice(0, 80) ?? "";
  return {
    key: launch.key,
    deviceId: launch.deviceId,
    engine: launch.engine,
    nativeId: launch.key.split(":")[2] ?? launch.id,
    configDir: "",
    cwd: launch.cwd,
    // a new worktree belongs to the repository it is made from
    repoRoot: launch.cwd,
    title: title || "新会话",
    ...(launch.branch ? { gitBranch: launch.branch } : {}),
    state: launch.phase === "failed" ? "stopped" : "running",
    lastActivityAt: launch.createdAt,
    hidden: false,
    online: true,
  };
}

/** The branch a new worktree gets unless the user names one: `nexagent/` and six random characters. */
export function randomBranch(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return "nexagent/" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => alphabet[byte % alphabet.length]).join("");
}

export function useLaunches(sessions: readonly CliSessionView[], onSettled?: () => void) {
  const review = useReview();
  const [launches, setLaunches] = useState<Launch[]>([]);
  const attempts = useRef(new Map<string, Attempt>());
  const running = useRef(new Set<string>());
  const echoes = useRef(new Map<CliSessionKey, LaunchEcho>());
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const patch = useCallback((id: string, delta: Partial<Launch>) => {
    setLaunches((current) => current.map((launch) => (launch.id === id ? { ...launch, ...delta } : launch)));
  }, []);

  const run = useCallback(async (launch: Launch) => {
    if (running.current.has(launch.id)) return;
    running.current.add(launch.id);
    let attempt = attempts.current.get(launch.id);
    if (!attempt) attempts.current.set(launch.id, (attempt = { requestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), sendRequestId: crypto.randomUUID() }));
    let target = launch.target;
    try {
      if (!target) {
        patch(launch.id, { phase: "starting", error: undefined });
        const options = { ...(launch.choice.model ? { model: launch.choice.model } : {}), ...(launch.choice.effort ? { effort: launch.choice.effort } : {}) };
        if (review && launch.branch) {
          target = await review.run("worktree-start", review.initial, { deviceId: launch.deviceId, engine: launch.engine, cwd: launch.cwd, branch: launch.branch, requestId: attempt.requestId });
          if (!target) throw new Error("未取得新会话");
        } else {
          target = (await startSession(launch.deviceId, launch.engine, launch.cwd, launch.branch ? { worktreeBranch: launch.branch, requestId: attempt.requestId, ...options } : options)).key;
        }
        // the composer of the new session keeps the model and effort it started with
        saveLaunch(target, launch.choice);
        patch(launch.id, { target });
        settled.current?.();
      }
      const text = launch.message.trim();
      if (text) {
        patch(launch.id, { phase: "sending", error: undefined });
        echoes.current.set(target, { text, at: launch.createdAt });
        for (let tries = 0; ; tries++) {
          try {
            await sendMessage(target, text, { delivery: "send", clientMessageId: attempt.clientMessageId, requestId: attempt.sendRequestId });
            break;
          } catch (cause) {
            // the computer lists a just-started session once the CLI is up
            if (tries < 30 && cause instanceof CliApiError && cause.code === "not_found") { await wait(500); continue; }
            throw cause;
          }
        }
      }
      patch(launch.id, { phase: "sent" });
      settled.current?.();
    } catch (cause) {
      if (target) echoes.current.delete(target);
      patch(launch.id, { phase: "failed", error: target ? cliErrorText(cause, "消息没有发出") : cliErrorText(cause, "没能启动") });
    } finally {
      running.current.delete(launch.id);
    }
  }, [patch, review]);

  const launch = useCallback((request: LaunchRequest): Launch => {
    const id = crypto.randomUUID();
    const entry: Launch = { ...request, id, key: `${request.deviceId}:${request.engine}:${LAUNCH_PREFIX}${id.slice(0, 8)}` as CliSessionKey, createdAt: Date.now(), phase: "starting" };
    setLaunches((current) => [entry, ...current]);
    void run(entry);
    return entry;
  }, [run]);

  const retry = useCallback((id: string) => {
    const entry = launches.find((launch) => launch.id === id);
    if (entry) void run(entry);
  }, [launches, run]);

  const dismiss = useCallback((id: string) => {
    if (running.current.has(id)) return;
    attempts.current.delete(id);
    setLaunches((current) => current.filter((launch) => launch.id !== id));
  }, []);

  // a launch whose session is listed and whose message went out is done: the real row takes over
  const listed = new Set(sessions.map((session) => session.key));
  const done = launches.filter((entry) => entry.target && listed.has(entry.target) && entry.phase === "sent");
  useEffect(() => {
    if (!done.length) return;
    const ids = new Set(done.map((entry) => entry.id));
    for (const id of ids) attempts.current.delete(id);
    setLaunches((current) => current.filter((entry) => !ids.has(entry.id)));
  }, [done.map((entry) => entry.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return { launches, launch, retry, dismiss, done, echo: (key: CliSessionKey) => echoes.current.get(key) };
}
