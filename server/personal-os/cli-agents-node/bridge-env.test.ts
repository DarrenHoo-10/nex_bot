// The bridge hands its injected environment to the herdr-core client it builds itself.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCliMessage } from "../../../shared/cli-agents.ts";

const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("./hc.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hc.ts")>();
  class CapturingCore {
    constructor(options: Record<string, unknown>) {
      created.push(options);
    }
    ensureStarted() {
      return new Promise<void>(() => {});
    }
    close() {}
    state() {
      return "starting";
    }
    on() {
      return this;
    }
    subscribe() {
      return new Promise<never>(() => {});
    }
    list() {
      return new Promise<never>(() => {});
    }
  }
  return { ...actual, HerdrCore: CapturingCore };
});

const { CliAgentBridge } = await import("./bridge.ts");

let root: string;
const bridges: Array<InstanceType<typeof CliAgentBridge>> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cli-bridge-env-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  created.length = 0;
});
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.detach();
  rmSync(root, { recursive: true, force: true });
});

function make(env?: NodeJS.ProcessEnv) {
  const bridge = new CliAgentBridge({
    dir: path.join(root, "data"),
    binary: path.resolve("C:\\fake\\herdr-core\\herdr-core.exe"),
    claudeDirs: [path.join(root, "claude")],
    codexHomes: [path.join(root, "codex")],
    resolveCli: async () => null,
    cliVersion: async () => null,
    homedir: path.join(root, "home"),
    pluginDir: null,
    ...(env ? { env } : {}),
  });
  bridges.push(bridge);
  return bridge;
}

async function linked(bridge: InstanceType<typeof CliAgentBridge>): Promise<void> {
  await bridge.prepare();
  bridge.setScope("https://core.test", "ws-1");
  bridge.link({ json: (_message: DeviceCliMessage) => true, binary: () => true });
  const end = Date.now() + 5000;
  while (created.length === 0) {
    if (Date.now() > end) throw new Error("herdr-core client was never created");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("herdr-core environment", () => {
  it("passes the bridge's injected environment to the client", async () => {
    const env = { PATH: "/login/shell/bin", HTTPS_PROXY: "http://127.0.0.1:7890" };
    await linked(make(env));
    expect(created).toHaveLength(1);
    expect(created[0].env).toBe(env);
  });

  it("leaves the choice to the client when no environment was injected", async () => {
    await linked(make());
    expect(created).toHaveLength(1);
    expect("env" in created[0]).toBe(false);
  });
});
