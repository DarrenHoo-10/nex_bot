// The packaged macOS herdr-core, opt in: NEX_HC_REAL=1 on a Mac with the pinned binary staged
// (`node scripts/prepare-herdr-core.mjs --current`, or the app's executor bundle).
//
// It runs its own isolated core (`HC_SESSION=nexbot-<hash8>`, its own socket), a stand-in program
// (scripts/testing/fake-tui.mjs, never claude or codex) and removes every trace afterwards. Only this test's own
// session is touched; never any other herdr-core, ~/.claude or ~/.codex.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { HC_SOCKET_MAX_BYTES, HerdrCore, hcSocketPath, locateHerdrCore } from "./hc.ts";

const binary = locateHerdrCore();
const real = process.env.NEX_HC_REAL === "1" && process.platform === "darwin" && binary !== null;

async function until<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.runIf(real)("the real macOS herdr-core (NEX_HC_REAL=1)", () => {
  const tui = path.resolve("scripts/testing/fake-tui.mjs");
  const hash = randomBytes(4).toString("hex");
  const session = `nexbot-${hash}`;
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-hc-real-"));
  const socket = hcSocketPath({ hash, dataDir: root, platform: "darwin", tmpdir: os.tmpdir() });
  const clients: HerdrCore[] = [];

  afterAll(async () => {
    if (!/^nexbot-[0-9a-f]{8}$/.test(session)) return;
    try {
      const probe = new HerdrCore({ binary: binary!, session, socket, startTimeoutMs: 5000 });
      clients.push(probe);
      await probe.ensureStarted();
      for (const terminal of (await probe.list({ all: true })).terminals) {
        if (terminal.state === "live" && terminal.pid) {
          try {
            process.kill(terminal.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // the core may already be gone
    }
    for (const client of clients) client.close();
    try {
      execFileSync(binary!, ["server", "stop"], { env: { ...process.env, HC_SESSION: session, HC_SOCKET: socket }, stdio: "ignore", timeout: 20_000 });
    } catch {
      // already stopped
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The core's state folder and any holder sockets next to its socket, named after this session only.
    const home = os.homedir();
    for (const base of [path.join(home, ".local", "state", "herdr-core"), path.join(home, "Library", "Application Support", "herdr-core")]) {
      rmSync(path.join(base, session), { recursive: true, force: true });
    }
    for (const dir of new Set([path.dirname(socket), os.tmpdir()])) {
      try {
        for (const name of readdirSync(dir)) if (name.includes(hash)) rmSync(path.join(dir, name), { recursive: true, force: true });
      } catch {
        // nothing to remove
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the socket path within the Unix limit", () => {
    expect(Buffer.byteLength(socket)).toBeLessThan(HC_SOCKET_MAX_BYTES);
    expect(existsSync(tui)).toBe(true);
  });

  it("starts a program with the injected environment, relays its terminal and keeps it alive after detaching", async () => {
    mkdirSync(path.dirname(socket), { recursive: true });
    // `env` stands for the login shell environment the executor host captures: the core, and so its terminals, inherit it.
    const core = new HerdrCore({ binary: binary!, session, socket, env: { ...process.env, NEX_LOGIN_MARK: "from-login-shell" } });
    clients.push(core);
    await core.ensureStarted();
    expect(core.state().status).toBe("ready");
    expect(existsSync(socket)).toBe(true);

    const terminal = await core.run({
      argv: ["/bin/sh", "-c", 'echo "MARK=$NEX_LOGIN_MARK"; exec "$0" "$1"', process.execPath, tui],
      cwd: root,
      name: "nexbot-real-mac",
      labels: { nexbot: "1" },
      size: { cols: 100, rows: 30 },
      keep: false,
    });
    expect(terminal.pid).toBeGreaterThan(0);

    const stream = await core.attach({ terminal: terminal.address, cols: 100, rows: 30 });
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    await until(() => output.includes("MARK=from-login-shell"), "the injected variable in the program's environment");
    await until(() => output.includes("fake>"), "the prompt of the fake program");
    stream.write("hello\r");
    await until(() => output.includes("you said: hello"), "the echoed line");

    // Detaching leaves the program running in herdr-core, and a second client sees it.
    stream.close();
    const other = new HerdrCore({ binary: binary!, session, socket });
    clients.push(other);
    await other.ensureStarted();
    const live = await other.list({ labels: { nexbot: "1" } });
    expect(live.terminals.filter((t) => t.state === "live")).toHaveLength(1);
  }, 120_000);
});
