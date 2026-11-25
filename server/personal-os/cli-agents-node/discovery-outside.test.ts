// How discovery decides a session can take messages from outside nex_bot's terminals.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionDiscovery } from "./discovery.ts";
import type { CommandRunner } from "./liveness.ts";

const CID = "00000000-0000-4000-8000-000000000001";
const XID = "019a0000-0000-7000-8000-000000000001";
const LSTART = "Sun Nov 15 09:00:00 2026";
const run: CommandRunner = async (_file, args) => ({ code: 0, stdout: args[args.length - 1].split(",").map((p) => `${p} ${LSTART}`).join("\n") });

let root: string;
let claudeDir: string;
let codexHome: string;
const found: SessionDiscovery[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cli-disc-out-"));
  claudeDir = path.join(root, "claude");
  codexHome = path.join(root, "codex");
  mkdirSync(path.join(claudeDir, "projects", "p"), { recursive: true });
  mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
});
afterEach(() => {
  for (const discovery of found.splice(0)) discovery.stop();
  rmSync(root, { recursive: true, force: true });
});

function claudeSession(extra: Record<string, unknown>): void {
  const file = path.join(claudeDir, "projects", "p", `${CID}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date(Date.now() - 60_000).toISOString(), cwd: root, message: { role: "user", content: "hi" } }) + "\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  writeFileSync(path.join(claudeDir, "sessions", "100.json"), JSON.stringify({ pid: 100, sessionId: CID, cwd: root, entrypoint: "cli", status: "idle", procStart: LSTART, updatedAt: Date.now(), ...extra }));
}

function codexSession(): void {
  const day = new Date(Date.now() - 3_600_000);
  const folder = path.join(codexHome, "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-11-15T10-00-00-${XID}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: day.toISOString(), type: "session_meta", payload: { id: XID, cwd: root, originator: "codex-tui", source: "cli", cli_version: "0.99.0" } }),
      JSON.stringify({ timestamp: day.toISOString(), type: "event_msg", payload: { type: "user_message", message: "earlier" } }),
    ].join("\n") + "\n",
  );
  utimesSync(file, day, day);
}

function make(options: ConstructorParameters<typeof SessionDiscovery>[0] = {}): SessionDiscovery {
  const discovery = new SessionDiscovery({
    claudeDirs: [claudeDir],
    codexHomes: [codexHome],
    claudeLive: { isAlive: () => true, start: { platform: "linux", run } },
    codex: { writer: () => "no" },
    coalesceMs: 0,
    ...options,
  });
  found.push(discovery);
  return discovery;
}

describe("sendVia", () => {
  it("is inbox for a live Claude session that speaks protocol 1, with a private route", async () => {
    claudeSession({ messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-abc", peerProtocol: 1 });
    const discovery = make();
    await discovery.refresh();
    const ref = `claude:${CID}`;
    expect(discovery.get(ref)?.sendVia).toBe("inbox");
    expect(JSON.stringify(discovery.get(ref))).not.toContain("cc-msg-abc");
    expect(discovery.routeFor(ref)).toEqual({ via: "inbox", configDir: claudeDir, pid: 100, socketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-abc", sessionId: CID });
  });

  it("is absent without a socket or for another protocol version", async () => {
    claudeSession({});
    const plain = make();
    await plain.refresh();
    expect(plain.get(`claude:${CID}`)?.sendVia).toBeUndefined();
    expect(plain.routeFor(`claude:${CID}`)).toBeNull();

    claudeSession({ messagingSocketPath: "/tmp/x.sock", peerProtocol: 2 });
    const other = make();
    await other.refresh();
    expect(other.get(`claude:${CID}`)?.sendVia).toBeUndefined();
  });

  it("is terminal, not inbox, once the session runs in a nex_bot terminal", async () => {
    claudeSession({ messagingSocketPath: "/tmp/x.sock", peerProtocol: 1 });
    const discovery = make({ nexbotTerminals: () => new Map([[`claude:${CID}`, "term-1"]]) });
    await discovery.refresh();
    expect(discovery.get(`claude:${CID}`)?.sendVia).toBe("terminal");
    expect(discovery.routeFor(`claude:${CID}`)).toMatchObject({ via: "inbox", sessionId: CID });
  });

  it("is daemon for a Codex thread the shared daemon has loaded, and not before it answers", async () => {
    codexSession();
    let threads: ReadonlySet<string> | undefined;
    const refreshed: string[] = [];
    const discovery = make({
      codexDaemon: {
        threads: () => threads,
        refresh: async (home) => void refreshed.push(home),
      },
    });
    await discovery.refresh();
    expect(refreshed).toContain(codexHome);
    expect(discovery.get(`codex:${XID}`)?.sendVia).toBeUndefined();
    expect(discovery.get(`codex:${XID}`)?.state).toBe("stopped");

    threads = new Set([XID]);
    await discovery.refresh();
    expect(discovery.get(`codex:${XID}`)).toMatchObject({ sendVia: "daemon", state: "idle" });
    expect(discovery.routeFor(`codex:${XID}`)).toEqual({ via: "daemon", home: codexHome, threadId: XID });
  });

  it("is terminal for a loaded Codex thread that also runs in a nex_bot terminal", async () => {
    codexSession();
    const discovery = make({
      nexbotTerminals: () => new Map([[`codex:${XID}`, "term-2"]]),
      codexDaemon: { threads: () => new Set([XID]), refresh: async () => {} },
    });
    await discovery.refresh();
    expect(discovery.get(`codex:${XID}`)?.sendVia).toBe("terminal");
    expect(discovery.routeFor(`codex:${XID}`)).toBeNull();
  });

  it("survives a daemon whose refresh throws", async () => {
    codexSession();
    const errors: unknown[] = [];
    const discovery = make({
      onError: (error) => errors.push(error),
      codexDaemon: {
        threads: () => undefined,
        refresh: async () => {
          throw new Error("daemon exploded");
        },
      },
    });
    await discovery.refresh();
    expect(discovery.get(`codex:${XID}`)).toBeTruthy();
  });
});
