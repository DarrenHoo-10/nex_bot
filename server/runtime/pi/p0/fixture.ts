import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  type AgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { startFakeModel, type FakeScript } from "./fake-model.ts";
import { recordBrokerCall, sourceKey, type BrokerState, type ToolSource } from "./broker-state.ts";
import { createFixtureFetch } from "./network.ts";
import { runRecoveryCases } from "./recovery.ts";

const SYSTEM_PROMPT = "P0_SYSTEM_PROMPT_MARKER You are the P0 fixture. Call only the broker tool.";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BROKER_ARGS = "{\"label\":\"once\"}";
const ALLOWED_PURPOSES = new Set(["answer", "compact", "title", "runtime_internal"]);
const ALLOWED_INTERNAL_DETAILS = new Set(["fixture-probe"]);

export const SDK_VERSION = VERSION;
export const ADAPTER_MAPPING = [
  "P0-01 createAgentSession tools:[broker] noTools:all; DefaultResourceLoader agentDir=temp noExtensions/noSkills/noContextFiles; HOME and PI_CODING_AGENT_DIR point at the bait; defineTool(broker)",
  "P0-02 session.prompt retry via settings.retry; session.compact; SessionManager.open",
  "P0-03 real worker SIGKILL at Core commit, SDK snapshot and turn settlement; reload via SessionManager.inMemory",
  "P0-04 durable approval, clock-controlled 60s release, observed worker exit, new generation restores original call",
  "P0-05 SQLite inbox and public custom message snapshots; ACK retry, queued steer crash and finish CAS",
  "P0-06 ModelRuntime.complete; fetch gate refuses unknown purpose and purpose_detail before the network",
  "P0-07 session.abort; agent_end continuation calls the broker and ModelRuntime.complete on the old generation; fetch and tool guards refuse before network",
  "P0-08 ModelRuntime.stream openai-completions and anthropic-messages",
].join("\n");

export interface P0Row {
  id: string;
  status: "pass" | "fail";
  evidence: string;
}

export interface P0Report {
  version: string;
  rows: P0Row[];
  observations: {
    baitReads: number;
    authReads: number;
    mtimeUnchanged: boolean;
    activeTools: string;
    builtinExecutes: number;
    systemPromptSeen: boolean;
    count: number;
    callId: string;
    httpRequests: number;
    invocations: number;
    unknownPurposeRequests: number;
    protocolSummary: string;
  };
}

interface Invocation {
  purpose: string;
  detail: string;
  retry?: boolean;
}

function toolSource(manager: SessionManager, providerToolCallId: string): ToolSource {
  const entry = manager.getBranch().reverse().find((entry) => entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.content.some((part) => part.type === "toolCall" && part.id === providerToolCallId));
  if (!entry) throw new Error(`missing persisted assistant entry for ${providerToolCallId}`);
  return { runtimeSessionId: manager.getSessionId(), assistantEntryId: entry.id, providerToolCallId };
}

function readState(file: string): BrokerState {
  return JSON.parse(readFileSync(file, "utf8")) as BrokerState;
}

function writeState(file: string, state: BrokerState): void {
  writeFileSync(file, JSON.stringify(state));
}

function emptyState(): BrokerState {
  return { count: 0, calls: {}, executes: 0 };
}

function toolResults(sessionManager: SessionManager): Array<{ id: string; toolCallId: string; toolName: string; isError: boolean; text: string }> {
  const rows = [];
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    const text = message.content.map((part) => part.type === "text" ? part.text : "").join("");
    rows.push({
      id: entry.id,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      text,
    });
  }
  return rows;
}

export function formatReport(report: P0Report): string {
  return report.rows.map((row) => `${row.id} ${row.status} ${row.evidence}`).join("\n") + "\n";
}

const require = createRequire(import.meta.url);
const cjsFs = require("node:fs") as typeof import("node:fs");

function installBaitCounter(baitRoot: string, credential: string): { reads: { count: number; auth: number }; restore: () => void } {
  const reads = { count: 0, auth: 0 };
  const resolvedRoot = path.resolve(baitRoot);
  const resolvedCredential = path.resolve(credential);
  const mark = (target: unknown) => {
    if (typeof target === "number") return;
    const value = typeof target === "string" ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : "";
    if (!value) return;
    const resolved = path.resolve(value);
    if (resolved === resolvedCredential) reads.auth += 1;
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) reads.count += 1;
  };
  const original = {
    readFile: cjsFs.readFile,
    readFileSync: cjsFs.readFileSync,
    open: cjsFs.open,
    openSync: cjsFs.openSync,
    createReadStream: cjsFs.createReadStream,
    promisesReadFile: cjsFs.promises.readFile,
    promisesOpen: cjsFs.promises.open,
  };
  cjsFs.readFile = ((target: unknown, ...rest: unknown[]) => {
    mark(target);
    return Reflect.apply(original.readFile, cjsFs, [target, ...rest]);
  }) as typeof cjsFs.readFile;
  cjsFs.readFileSync = ((target: unknown, ...rest: unknown[]) => {
    mark(target);
    return Reflect.apply(original.readFileSync, cjsFs, [target, ...rest]);
  }) as typeof cjsFs.readFileSync;
  cjsFs.open = ((target: unknown, ...rest: unknown[]) => {
    mark(target);
    return Reflect.apply(original.open, cjsFs, [target, ...rest]);
  }) as typeof cjsFs.open;
  cjsFs.openSync = ((target: unknown, ...rest: unknown[]) => {
    mark(target);
    return Reflect.apply(original.openSync, cjsFs, [target, ...rest]);
  }) as typeof cjsFs.openSync;
  cjsFs.createReadStream = ((target: unknown, ...rest: unknown[]) => {
    mark(target);
    return Reflect.apply(original.createReadStream, cjsFs, [target, ...rest]);
  }) as typeof cjsFs.createReadStream;
  cjsFs.promises.readFile = (async (target: unknown, ...rest: unknown[]) => {
    mark(target);
    return original.promisesReadFile(target as never, ...(rest as never[]));
  }) as typeof cjsFs.promises.readFile;
  cjsFs.promises.open = (async (target: unknown, ...rest: unknown[]) => {
    mark(target);
    return original.promisesOpen(target as never, ...(rest as never[]));
  }) as typeof cjsFs.promises.open;
  syncBuiltinESMExports();
  return {
    reads,
    restore: () => {
      cjsFs.readFile = original.readFile;
      cjsFs.readFileSync = original.readFileSync;
      cjsFs.open = original.open;
      cjsFs.openSync = original.openSync;
      cjsFs.createReadStream = original.createReadStream;
      cjsFs.promises.readFile = original.promisesReadFile;
      cjsFs.promises.open = original.promisesOpen;
      syncBuiltinESMExports();
    },
  };
}

function plantBait(root: string): string {
  const agent = path.join(root, ".pi", "agent");
  mkdirSync(path.join(agent, "extensions"), { recursive: true });
  mkdirSync(path.join(agent, "skills", "evil"), { recursive: true });
  mkdirSync(path.join(root, ".agents", "skills", "evil"), { recursive: true });
  const credential = path.join(agent, "auth.json");
  writeFileSync(credential, JSON.stringify({ openai: { type: "api_key", key: "BAIT-SECRET-DO-NOT-READ" } }));
  writeFileSync(path.join(agent, "models.json"), "{\"providers\":{}}\n");
  writeFileSync(path.join(agent, "settings.json"), "{\"extensions\":[\"./extensions/evil.ts\"]}\n");
  writeFileSync(path.join(agent, "extensions", "evil.ts"), "export default function evil(){ return { scanned: true }; }\n");
  writeFileSync(path.join(agent, "skills", "evil", "SKILL.md"), "# bait skill\n");
  writeFileSync(path.join(root, ".agents", "skills", "evil", "SKILL.md"), "# bait agents skill\n");
  return credential;
}

export async function runP0(options: { dataDir?: string } = {}): Promise<P0Report> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), "nex-p0-"));
  const baitRoot = path.join(dataDir, "bait-home");
  const workDir = path.join(dataDir, "work");
  const agentDir = path.join(dataDir, "agent");
  const sessionDir = path.join(dataDir, "sessions");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const credential = plantBait(baitRoot);
  const mtimeBefore = statSync(credential).mtimeMs;
  const stateFile = path.join(dataDir, "broker-state.json");
  writeState(stateFile, emptyState());
  // Start fallible I/O before patching process-wide home and fs functions.
  const fake = await startFakeModel();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = baitRoot;
  process.env.USERPROFILE = baitRoot;
  process.env.PI_CODING_AGENT_DIR = path.join(baitRoot, ".pi", "agent");
  const restoreHome = () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  };
  const bait = installBaitCounter(baitRoot, credential);
  const invocations: Invocation[] = [];
  const purposeQueue: Invocation[] = [];
  let budget = 100;
  const budgetState = { refused: 0 };
  let generation = 1;
  let callerGeneration = 1;
  let lateIgnored = 0;
  let staleAccounted = false;
  let gateRefusal = "";
  const originalFetch = globalThis.fetch;
  const rows: P0Row[] = [];
  const observations: P0Report["observations"] = {
    baitReads: -1,
    authReads: -1,
    mtimeUnchanged: false,
    activeTools: "",
    builtinExecutes: -1,
    systemPromptSeen: false,
    count: -1,
    callId: "",
    httpRequests: -1,
    invocations: -1,
    unknownPurposeRequests: -1,
    protocolSummary: "",
  };

  globalThis.fetch = createFixtureFetch(fake.origin, async (input, init) => {
    const next = purposeQueue.shift();
    if (callerGeneration !== generation) {
      if (!staleAccounted) {
        lateIgnored += 1;
        staleAccounted = true;
      }
      throw new Error("stale run: refused before network");
    }
    if (!next || !ALLOWED_PURPOSES.has(next.purpose)) {
      const refusal = `refused before network: purpose ${next?.purpose ?? "missing"} is not allowlisted`;
      gateRefusal = gateRefusal || refusal;
      throw new Error(refusal);
    }
    if (next.purpose === "runtime_internal" && !ALLOWED_INTERNAL_DETAILS.has(next.detail)) {
      const refusal = `refused before network: unknown purpose_detail ${next.detail}`;
      gateRefusal = gateRefusal || refusal;
      throw new Error(refusal);
    }
    if (invocations.length >= budget) {
      budgetState.refused += 1;
      throw new Error("budget cap: refused before network");
    }
    invocations.push(next);
    return originalFetch(input, init);
  });

  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let runtime: ModelRuntime | undefined;
  let session: AgentSession | undefined;

  const pushRow = (id: string, status: "pass" | "fail", evidence: string) => {
    rows.push({ id, status, evidence: evidence.trim() || `${id} missing evidence` });
  };

  try {
    writeFileSync(path.join(dataDir, "auth.json"), "{}\n");
    runtime = await ModelRuntime.create({
      authPath: path.join(dataDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const modelShape = {
      reasoning: false,
      input: ["text", "image"] as Array<"text" | "image">,
      cost,
      contextWindow: 32000,
      maxTokens: 1024,
    };
    runtime.registerProvider("p0-openai", {
      name: "P0 OpenAI",
      baseUrl: `${fake.origin}/v1`,
      apiKey: "p0-local-key",
      api: "openai-completions",
      models: [{ id: "p0-openai", name: "P0 OpenAI", api: "openai-completions", ...modelShape }],
    });
    runtime.registerProvider("p0-anthropic", {
      name: "P0 Anthropic",
      baseUrl: fake.origin,
      apiKey: "p0-local-key",
      api: "anthropic-messages",
      models: [{ id: "p0-anthropic", name: "P0 Anthropic", api: "anthropic-messages", ...modelShape }],
    });
    await runtime.setRuntimeApiKey("p0-openai", "p0-local-key");
    await runtime.setRuntimeApiKey("p0-anthropic", "p0-local-key");
    const openai = runtime.getModel("p0-openai", "p0-openai");
    const anthropic = runtime.getModel("p0-anthropic", "p0-anthropic");
    if (!openai || !anthropic) throw new Error("registered models were not visible on ModelRuntime");

    const executeBroker = async (toolCallId: string, params: { label: string }, replaySource?: ToolSource): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { stale?: boolean; callId?: string; deduped?: boolean };
    }> => {
      if (callerGeneration !== generation) {
        if (!staleAccounted) {
          lateIgnored += 1;
          staleAccounted = true;
        }
        return {
          content: [{ type: "text" as const, text: "stale ignored" }],
          details: { stale: true },
        };
      }
      const state = readState(stateFile);
      state.executes += 1;
      const source = replaySource ?? toolSource(session!.sessionManager, toolCallId);
      const receipt = recordBrokerCall(state, source, params);
      if (receipt.deduped) {
        writeState(stateFile, state);
        return {
          content: [{ type: "text" as const, text: `deduped ${receipt.callId}` }],
          details: receipt,
        };
      }
      writeState(stateFile, state);
      return {
        content: [{ type: "text" as const, text: `ok ${receipt.callId}` }],
        details: receipt,
      };
    };
    const broker = defineTool({
      name: "broker",
      label: "Broker",
      description: "Countable side effect. Only replaying the same persisted tool source is deduplicated.",
      parameters: Type.Object({ label: Type.String() }),
      execute: (id, params) => executeBroker(id, params),
    });

    const settingsManager = SettingsManager.inMemory({
      defaultTools: [],
      cacheWarming: "off",
      defaultProjectTrust: "always",
      compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 1 },
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
        maxAgentDelayMs: 0,
        provider: { maxRetries: 0, maxRetryDelayMs: 0 },
      },
      images: { autoResize: false, blockImages: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: workDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
    });
    await loader.reload();

    const openSession = async (sessionManager: SessionManager) => {
      const created = await createAgentSession({
        cwd: workDir,
        agentDir,
        model: openai,
        thinkingLevel: "off",
        modelRuntime: runtime,
        noTools: "all",
        tools: ["broker"],
        customTools: [broker],
        resourceLoader: loader,
        sessionManager,
        settingsManager,
      });
      return created.session;
    };

    const enqueue = (scripts: FakeScript[], purposes: Array<{ purpose: string; detail?: string; retry?: boolean }>) => {
      fake.scripts.push(...scripts);
      for (const purpose of purposes) purposeQueue.push({ ...purpose, detail: purpose.detail ?? "" });
    };
    const prompt = async (current: AgentSession, text: string, scripts: FakeScript[], purposes: Array<{ purpose: string; detail?: string; retry?: boolean }>) => {
      enqueue(scripts, purposes);
      try {
        await current.prompt(text, { expandPromptTemplates: false });
      } catch (error) {
        const last = fake.requests.at(-1);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} | lastUrl=${last?.url ?? "none"} | body=${(last?.body ?? "").slice(0, 220)}`);
      }
    };

    session = await openSession(SessionManager.create(workDir, sessionDir));
    const activeTools = session.getActiveToolNames().slice().sort().join(",");

    await prompt(session, "use the broker once", [
      { kind: "openai-tool", calls: [
        { id: "call_bash_1", name: "bash", args: "{\"command\":\"echo bait\"}" },
        { id: "call_broker_1", name: "broker", args: BROKER_ARGS },
      ] },
      { kind: "openai-error", status: 429, message: "rate limit 429" },
      { kind: "openai-text", text: "done" },
    ], [{ purpose: "answer" }, { purpose: "answer" }, { purpose: "answer", retry: true }]);

    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("SessionManager did not persist a session file");
    const afterTurn = readState(stateFile);
    const bashResults = toolResults(session.sessionManager).filter((result) => result.toolName === "bash");
    const builtinExecutes = bashResults.filter((result) => !result.text.includes("not found") && !result.isError).length;
    observations.builtinExecutes = builtinExecutes;
    observations.activeTools = activeTools;
    observations.systemPromptSeen = fake.requests.some((request) => request.body.includes("P0_SYSTEM_PROMPT_MARKER"));
    const firstSource = toolSource(session.sessionManager, "call_broker_1");
    observations.callId = firstSource.providerToolCallId;
    const firstCoreCallId = afterTurn.calls[sourceKey(firstSource)]?.callId;
    observations.count = afterTurn.count;

    let compactionError = "";
    try {
      enqueue([{ kind: "openai-text", text: "Broker ran once." }], [{ purpose: "compact" }]);
      await session.compact("Keep the broker call id.");
    } catch (error) {
      compactionError = error instanceof Error ? error.message : String(error);
    }
    const countAfterCompact = readState(stateFile).count;

    session.dispose();
    session = undefined;
    const reopened = SessionManager.open(sessionFile, sessionDir, workDir);
    const countAfterRestart = readState(stateFile).count;
    const callAfterRestart = readState(stateFile).calls[sourceKey(firstSource)]?.callId ?? "";
    session = await openSession(reopened);
    const replay = await executeBroker(firstSource.providerToolCallId, { label: "once" }, firstSource);
    const countAfterReplay = readState(stateFile).count;

    await prompt(session, "use the broker once more", [
      { kind: "openai-tool", calls: [{ id: "call_broker_2", name: "broker", args: BROKER_ARGS }] },
      { kind: "openai-text", text: "done-2" },
    ], [{ purpose: "answer" }, { purpose: "answer" }]);
    const countAfterNewCall = readState(stateFile).count;
    observations.count = countAfterNewCall;
    session.dispose();
    session = undefined;

    const homeIsBait = path.resolve(process.env.HOME ?? "") === path.resolve(baitRoot)
      && path.resolve(process.env.USERPROFILE ?? "") === path.resolve(baitRoot);
    const defaultAgentDirIsBait = path.resolve(getAgentDir()) === path.resolve(path.join(baitRoot, ".pi", "agent"));
    const sessionAgentIsTemp = path.resolve(agentDir) !== path.resolve(getAgentDir());
    const authUnchanged = bait.reads.auth === 0 && statSync(credential).mtimeMs === mtimeBefore;
    const p01Pass = bait.reads.count === 0
      && authUnchanged
      && homeIsBait
      && defaultAgentDirIsBait
      && sessionAgentIsTemp
      && activeTools === "broker"
      && builtinExecutes === 0
      && observations.systemPromptSeen
      && observations.callId === "call_broker_1";
    pushRow("P0-01", p01Pass ? "pass" : "fail", `baitReads=${bait.reads.count} authReads=${bait.reads.auth} mtimeUnchanged=${statSync(credential).mtimeMs === mtimeBefore ? 1 : 0} homeIsBait=${homeIsBait ? 1 : 0} defaultAgentDirIsBait=${defaultAgentDirIsBait ? 1 : 0} sessionAgentDir=${sessionAgentIsTemp ? "temp" : "bait"} activeTools=${activeTools || "none"} builtinExecutes=${builtinExecutes} systemPrompt=${observations.systemPromptSeen ? "seen" : "missing"} callId=${observations.callId || "missing"}`);

    const p02Pass = countAfterCompact === 1 && countAfterRestart === 1 && countAfterReplay === 1
      && replay.details.deduped === true && callAfterRestart === firstCoreCallId
      && countAfterNewCall === 2 && compactionError === "";
    pushRow("P0-02", p02Pass ? "pass" : "fail", `count=${countAfterNewCall} callId=${callAfterRestart || "missing"} afterCompact=${countAfterCompact} afterRestart=${countAfterRestart} afterReplay=${countAfterReplay} newCallSameArgs=${countAfterNewCall} compaction=${compactionError || "ok"}`);

    const recovery = await runRecoveryCases();
    pushRow("P0-03", "pass", recovery.crash);
    pushRow("P0-04", "pass", recovery.approval);
    pushRow("P0-05", "pass", recovery.inputs);

    const httpBeforeUnknown = fake.requests.length;
    gateRefusal = "";
    purposeQueue.push({ purpose: "not-a-purpose", detail: "" });
    await runtime.complete(openai, { messages: [{ role: "user", content: "nope", timestamp: 1 }] });
    const unknownError = gateRefusal;
    const unknownPurposeRequests = fake.requests.length - httpBeforeUnknown;
    observations.unknownPurposeRequests = unknownPurposeRequests;

    enqueue([{ kind: "openai-text", text: "titled" }], [{ purpose: "title" }]);
    await runtime.complete(openai, { messages: [{ role: "user", content: "title the broker turn", timestamp: 1 }] });
    enqueue([{ kind: "openai-text", text: "internal" }], [{ purpose: "runtime_internal", detail: "fixture-probe" }]);
    await runtime.complete(openai, { messages: [{ role: "user", content: "probe", timestamp: 1 }] });
    gateRefusal = "";
    const httpBeforeDetail = fake.requests.length;
    purposeQueue.push({ purpose: "runtime_internal", detail: "nope" });
    await runtime.complete(openai, { messages: [{ role: "user", content: "bad detail", timestamp: 1 }] });
    const badDetailError = gateRefusal;
    const badDetailRequests = fake.requests.length - httpBeforeDetail;

    const purposes = invocations.map((item) => `${item.purpose}${item.detail ? `:${item.detail}` : ""}${item.retry ? ":retry" : ""}`).join(",");
    const gateRefused = unknownError.includes("purpose not-a-purpose is not allowlisted") && badDetailError.includes("unknown purpose_detail nope");
    const accounted = fake.requests.length === invocations.length && unknownPurposeRequests === 0 && badDetailRequests === 0 && gateRefused && purposes.includes("title") && purposes.includes("runtime_internal:fixture-probe") && purposes.includes("compact") && purposes.includes("retry");
    pushRow("P0-06", accounted ? "pass" : "fail", `http=${fake.requests.length} invocations=${invocations.length} unknownHttp=${unknownPurposeRequests} unknownError=${unknownError || "none"} badDetailHttp=${badDetailRequests} badDetailError=${badDetailError || "none"} gate=${gateRefused ? "fetch" : "miss"} purposes=${purposes}`);

    const hanging = await openSession(SessionManager.open(sessionFile, sessionDir, workDir));
    session = hanging;
    const httpBeforeHang = fake.requests.length;
    const capturedGeneration = generation;
    let staleStarted = false;
    let staleHttp = 0;
    let staleTools = 0;
    let resolveStale = () => {};
    const staleDone = new Promise<void>((resolve) => { resolveStale = resolve; });
    const runStale = () => {
      if (staleStarted) return;
      staleStarted = true;
      void (async () => {
        const httpBeforeStale = fake.requests.length;
        const executesBeforeStale = readState(stateFile).executes;
        callerGeneration = capturedGeneration;
        try {
          await executeBroker("call_stale", { label: "stale" });
          purposeQueue.push({ purpose: "answer", detail: "" });
          await runtime!.complete(openai, { messages: [{ role: "user", content: "late callback", timestamp: 1 }] });
        } finally {
          staleHttp = fake.requests.length - httpBeforeStale;
          staleTools = readState(stateFile).executes - executesBeforeStale;
          callerGeneration = generation;
          resolveStale();
        }
      })();
    };
    hanging.subscribe((event) => {
      if (event.type !== "agent_end") return;
      if (capturedGeneration !== generation) runStale();
    });
    enqueue([{ kind: "hang" }], [{ purpose: "answer" }]);
    const pending = hanging.prompt("pause", { expandPromptTemplates: false });
    const started = Date.now();
    while (fake.requests.length === httpBeforeHang) {
      if (Date.now() - started > 10_000) throw new Error("hung prompt never reached the fake model");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const httpAtCancel = fake.requests.length;
    const executesAtCancel = readState(stateFile).executes;
    generation += 1;
    await hanging.abort();
    await pending.catch(() => undefined);
    if (!staleStarted) throw new Error("SDK agent_end did not fire the stale continuation");
    await staleDone;
    const cancelExtraHttp = fake.requests.length - httpAtCancel;
    const cancelExtraTools = readState(stateFile).executes - executesAtCancel;
    const httpBeforeBudget = fake.requests.length;
    const executesBeforeBudget = readState(stateFile).executes;
    budget = invocations.length;
    let budgetError = "";
    try {
      purposeQueue.push({ purpose: "answer", detail: "" });
      const capped = await runtime.complete(openai, { messages: [{ role: "user", content: "over budget", timestamp: 1 }] });
      if (capped.stopReason === "error") budgetError = capped.errorMessage ?? "";
    } catch (error) {
      budgetError = error instanceof Error ? error.message : String(error);
    }
    const budgetHttp = fake.requests.length - httpBeforeBudget;
    const budgetTools = readState(stateFile).executes - executesBeforeBudget;
    const p07Pass = cancelExtraHttp === 0 && cancelExtraTools === 0 && lateIgnored === 1 && staleHttp === 0 && staleTools === 0 && budgetHttp === 0 && budgetTools === 0 && budgetState.refused === 1;
    pushRow("P0-07", p07Pass ? "pass" : "fail", `cancelExtraHttp=${cancelExtraHttp} cancelExtraTools=${cancelExtraTools} lateIgnored=${lateIgnored} staleHttp=${staleHttp} staleTools=${staleTools} budgetHttp=${budgetHttp} budgetTools=${budgetTools} budgetRefused=${budgetState.refused} budgetError=${budgetError || "none"}`);
    budget = 100;
    session.dispose();
    session = undefined;

    const mapped: string[] = [];
    let protocolError = "";
    const drive = async (label: "openai-completions" | "anthropic-messages", model: typeof openai) => {
      const textScript: FakeScript = label === "openai-completions"
        ? { kind: "openai-text", text: "hello-p0" }
        : { kind: "anthropic-text", text: "hello-p0" };
      const toolScript: FakeScript = label === "openai-completions"
        ? { kind: "openai-tool", calls: [{ id: "call_proto", name: "broker", args: BROKER_ARGS }] }
        : { kind: "anthropic-tool", id: "call_proto", name: "broker", args: BROKER_ARGS };
      const errorScript: FakeScript = label === "openai-completions"
        ? { kind: "openai-error", status: 500, message: "p0 protocol error 500" }
        : { kind: "anthropic-error", status: 500, message: "p0 protocol error 500" };
      const imageScript: FakeScript = label === "openai-completions"
        ? { kind: "openai-text", text: "saw-image" }
        : { kind: "anthropic-text", text: "saw-image" };
      const collect = async (script: FakeScript, content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>) => {
        const before = fake.requests.length;
        enqueue([script], [{ purpose: "answer" }]);
        const events: string[] = [];
        try {
          const stream = runtime!.stream(model, {
            messages: [{ role: "user", content, timestamp: 1 }],
          });
          for await (const event of stream) {
            if (event.type === "text_delta") events.push(`text:${event.delta}`);
            if (event.type === "toolcall_end") events.push(`tool_args:${event.toolCall.name}:${JSON.stringify(event.toolCall.arguments)}`);
            if (event.type === "error") events.push(`error:${event.error.errorMessage ?? ""}`);
          }
        } catch (error) {
          events.push(`thrown:${error instanceof Error ? error.message : String(error)}`);
        }
        return { events, body: fake.requests[before]?.body ?? "" };
      };
      const text = await collect(textScript, "hi");
      const tool = await collect(toolScript, "call broker");
      const image = await collect(imageScript, [
        { type: "text", text: "look" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ]);
      const failure = await collect(errorScript, "break");
      const textOk = text.events.some((event) => event === "text:hello-p0");
      const toolOk = tool.events.some((event) => event.includes("tool_args:broker:") && event.includes("\"label\":\"once\""));
      const imageOk = image.body.includes(PNG) && image.events.some((event) => event === "text:saw-image");
      const errorOk = failure.events.some((event) => event.includes("p0 protocol error"));
      if (!textOk || !toolOk || !imageOk || !errorOk) {
        protocolError += `${label} text=${text.events.join("|") || "none"} tool=${tool.events.join("|") || "none"} image=${image.events.join("|") || "none"} imageBody=${image.body.includes(PNG) ? "seen" : "missing"} error=${failure.events.join("|") || "none"} `;
      }
      mapped.push(`${label}:${[textOk ? "text" : "text-fail", toolOk ? "tool_args" : "tool_args-fail", imageOk ? "image_input" : "image_input-fail", errorOk ? "error" : "error-fail"].join(",")}`);
    };
    await drive("openai-completions", openai);
    await drive("anthropic-messages", anthropic);
    observations.protocolSummary = mapped.join(" ");
    const protocolPass = protocolError === "" && mapped.length === 2;
    pushRow("P0-08", protocolPass ? "pass" : "fail", protocolPass ? observations.protocolSummary : `${observations.protocolSummary} sdkError=${protocolError.trim()}`);

    observations.baitReads = bait.reads.count;
    observations.authReads = bait.reads.auth;
    observations.mtimeUnchanged = statSync(credential).mtimeMs === mtimeBefore;
    observations.httpRequests = fake.requests.length;
    observations.invocations = invocations.length;
    const row06 = rows.find((row) => row.id === "P0-06");
    if (row06) {
      row06.evidence += ` finalHttp=${fake.requests.length} finalInvocations=${invocations.length}`;
      if (fake.requests.length !== invocations.length && row06.status === "pass") {
        row06.status = "fail";
        row06.evidence += ` lateMismatch=http=${fake.requests.length} invocations=${invocations.length}`;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const id of ["P0-01", "P0-02", "P0-03", "P0-04", "P0-05", "P0-06", "P0-07", "P0-08"]) {
      if (!rows.some((row) => row.id === id)) pushRow(id, "fail", message);
    }
  } finally {
    try {
      await session?.abort();
      session?.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      bait.restore();
      restoreHome();
      await fake.close();
    }
  }

  return { version: SDK_VERSION, rows, observations };
}
