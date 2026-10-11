import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveBackend } from "../backend.ts";
import { formatReport, runP0 } from "./fixture.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const reproPath = fileURLToPath(new URL("./repro.ts", import.meta.url));
const IDS = ["P0-01", "P0-02", "P0-03", "P0-04", "P0-05", "P0-06", "P0-07", "P0-08"];

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("runs the shipped Pi SDK fixture for P0-01 through P0-08", async () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const report = await runP0();
  expect(globalThis.fetch).toBe(originalFetch);
  expect(process.env.HOME).toBe(originalHome);
  expect(process.env.USERPROFILE).toBe(originalProfile);
  expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
  const text = formatReport(report);
  expect(report.version).toBe("1.0.4");
  expect(report.rows.map((row) => row.id)).toEqual(IDS);
  for (const id of IDS) {
    const lines = text.trim().split(/\r?\n/).filter((line) => line.startsWith(`${id} `));
    expect(lines).toHaveLength(1);
    expect(lines[0].split(" ").slice(2).join(" ").trim().length).toBeGreaterThan(0);
  }
  const byId = Object.fromEntries(report.rows.map((row) => [row.id, row]));

  expect(byId["P0-01"].status).toBe("pass");
  expect(report.observations.baitReads).toBe(0);
  expect(report.observations.authReads).toBe(0);
  expect(report.observations.mtimeUnchanged).toBe(true);
  expect(byId["P0-01"].evidence).toContain("homeIsBait=1");
  expect(byId["P0-01"].evidence).toContain("defaultAgentDirIsBait=1");
  expect(byId["P0-01"].evidence).toContain("sessionAgentDir=temp");
  expect(report.observations.activeTools).toBe("broker");
  expect(report.observations.builtinExecutes).toBe(0);
  expect(report.observations.systemPromptSeen).toBe(true);

  expect(byId["P0-02"].status).toBe("pass");
  expect(report.observations.count).toBe(2);
  expect(byId["P0-02"].evidence).toContain("afterReplay=1");
  expect(byId["P0-02"].evidence).toContain("newCallSameArgs=2");
  expect(report.observations.callId).toBe("call_broker_1");

  expect(byId["P0-03"].status).toBe("pass");
  expect(byId["P0-03"].evidence).toContain("hardKills=4 orphanProposalRecovered=1");
  expect(byId["P0-03"].evidence).toContain("effects=1 sdkResults=1");
  expect(byId["P0-03"].evidence).toContain("settledReplyReused=1");
  expect(byId["P0-04"].status).toBe("pass");
  expect(byId["P0-04"].evidence).toContain("releaseDeltaMs=60000 earlyRelease=0 workerExited=1");
  expect(byId["P0-04"].evidence).toContain("preApprovalEffects=0 resumedNewRun=1 sameCall=1 effects=1");
  expect(byId["P0-05"].status).toBe("pass");
  expect(byId["P0-05"].evidence).toContain("firstInputCrashRecovered=1");
  expect(byId["P0-05"].evidence).toContain("queuedSteerCrashRecovered=1");
  expect(byId["P0-05"].evidence).toContain("uniqueInputs=3 consumed=3 finishRaceGuarded=1 textNotCommand=1");

  expect(byId["P0-06"].status).toBe("pass");
  expect(report.observations.unknownPurposeRequests).toBe(0);
  expect(report.observations.httpRequests).toBe(report.observations.invocations);
  expect(byId["P0-06"].evidence).toContain("gate=fetch");
  expect(byId["P0-06"].evidence).toContain("purpose not-a-purpose is not allowlisted");
  expect(byId["P0-06"].evidence).toContain("unknown purpose_detail nope");
  expect(byId["P0-06"].evidence).toContain("unknownHttp=0");
  expect(byId["P0-06"].evidence).toContain("badDetailHttp=0");
  expect(byId["P0-06"].evidence).toContain("answer:retry");
  expect(byId["P0-06"].evidence).toContain(`finalHttp=${report.observations.httpRequests}`);
  expect(byId["P0-06"].evidence).toContain(`finalInvocations=${report.observations.invocations}`);

  expect(byId["P0-07"].status).toBe("pass");
  expect(byId["P0-07"].evidence).toContain("cancelExtraHttp=0");
  expect(byId["P0-07"].evidence).toContain("cancelExtraTools=0");
  expect(byId["P0-07"].evidence).toContain("lateIgnored=1");
  expect(byId["P0-07"].evidence).toContain("staleHttp=0");
  expect(byId["P0-07"].evidence).toContain("staleTools=0");
  expect(byId["P0-07"].evidence).toContain("budgetHttp=0");
  expect(byId["P0-07"].evidence).toContain("budgetRefused=1");

  expect(byId["P0-08"].status).toBe("pass");
  expect(report.observations.protocolSummary).toContain("openai-completions:text,tool_args,image_input,error");
  expect(report.observations.protocolSummary).toContain("anthropic-messages:text,tool_args,image_input,error");
}, 90_000);

it("passes the CLI only when all eight executable cases pass", async () => {
  const child = await runNode(["--experimental-strip-types", reproPath], { ...process.env });
  expect(child.code).toBe(0);
  expect(child.stdout.trim().split(/\r?\n/)).toHaveLength(8);
  expect(child.stdout).not.toContain(" fail ");
  expect(child.stdout).toContain("P0-03 pass hardKills=4");
}, 90_000);

it("keeps unset NEX_BACKEND on the legacy boot path", async () => {
  expect(resolveBackend({})).toBe("legacy");
  const serverIndex = readFileSync(fileURLToPath(new URL("../../../index.ts", import.meta.url)), "utf8");
  expect(serverIndex.includes("runtime/pi")).toBe(false);
  expect(serverIndex.includes("NEX_BACKEND")).toBe(false);
  const env = { ...process.env };
  delete env.NEX_BACKEND;
  const child = await runNode(["--experimental-strip-types", reproPath, "--boot-check"], env);
  expect(child.code).toBe(0);
  expect(child.stdout.trim()).toBe("legacy");
});
