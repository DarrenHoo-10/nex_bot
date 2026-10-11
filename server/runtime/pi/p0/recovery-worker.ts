import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RecoveryStore, SessionProjection, type CallRecord, type InputRecord } from "./recovery-store.ts";
import { createFixtureFetch } from "./network.ts";

export interface WorkerConfig {
  dir: string; origin: string; generation: number; holdAt?: string; now: number;
}
type WorkerCommand = { type: "continue"; checkpoint: string } | { type: "steer" } | { type: "approved"; callId: string };

const config = JSON.parse(process.argv[2]) as WorkerConfig;
const store = new RecoveryStore(path.join(config.dir, "core.db"));
const projection = new SessionProjection(path.join(config.dir, "projection.db"));
const work = path.join(config.dir, "work");
const agentDir = path.join(config.dir, "agent");
mkdirSync(work, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const manager = projection.load(work);
let session: AgentSession | undefined;
let requestId = 0;
let requestInputs: string[] = [];
let held = false;
const queued = new Set<string>();

function send(event: Record<string, unknown>): void { process.send?.(event); }
async function checkpoint(name: string): Promise<void> {
  if (config.holdAt === name && !held) {
    held = true;
    await new Promise<void>((resolve) => {
      const listener = (command: WorkerCommand) => {
        if (command.type !== "continue" || command.checkpoint !== name) return;
        process.off("message", listener);
        resolve();
      };
      process.on("message", listener);
      send({ checkpoint: name, held: true });
    });
  } else send({ checkpoint: name });
}
function inputEntry(input: InputRecord) {
  const matches = manager.getBranch().filter((entry) => entry.type === "custom_message"
    && entry.customType === "nex.input" && (entry.details as { inputId?: string } | undefined)?.inputId === input.id);
  if (matches.length > 1) throw new Error("duplicate runtime input");
  const found = matches[0];
  if (found?.type === "custom_message"
    && ((found.details as { hash?: string }).hash !== input.hash || found.content !== input.text)) {
    throw new Error("runtime input identity conflict");
  }
  return found;
}
function confirmInputs(): void {
  for (const input of store.pendingInputs()) {
    const entry = inputEntry(input);
    if (entry) store.markApplied(input, entry.id);
  }
}
function resultEntry(call: CallRecord) {
  if (call.session_id !== manager.getSessionId()) throw new Error("runtime session identity mismatch");
  const branch = manager.getBranch();
  const index = branch.findIndex((entry) => entry.id === call.entry_id);
  const source = branch[index];
  if (source?.type !== "message" || source.message.role !== "assistant"
    || !source.message.content.some((part) => part.type === "toolCall" && part.id === call.provider_id
      && part.name === "broker" && JSON.stringify(part.arguments) === call.args)) throw new Error("tool source identity mismatch");
  const later = branch.slice(index + 1);
  const nextSource = later.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant"
    && entry.message.content.some((part) => part.type === "toolCall" && part.id === call.provider_id));
  const scope = nextSource < 0 ? later : later.slice(0, nextSource);
  const results = scope.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.provider_id);
  if (results.length > 1) throw new Error("duplicate SDK tool result");
  const found = results[0];
  if (found?.type === "message" && found.message.role === "toolResult") {
    const expectedError = call.state === "cancelled";
    if (found.message.toolName !== "broker" || found.message.isError !== expectedError
      || found.message.content.length !== 1 || found.message.content[0].type !== "text" || found.message.content[0].text !== call.result) {
      throw new Error("SDK result conflicts with Core receipt");
    }
  }
  return found;
}
function confirmResults(): void {
  for (const call of store.calls()) {
    if (!call.result) continue;
    const entry = resultEntry(call);
    if (entry) store.delivered(call.id, entry.id);
  }
}
async function restoreCalls(): Promise<void> {
  // A worker can die after persisting the assistant entry but before the
  // Broker sees it. Reconcile those proposals too, using the original entry
  // id and the current trusted fixture policy, never a fabricated user prompt.
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type !== "toolCall") continue;
      if (store.calls().some((call) => call.session_id === manager.getSessionId() && call.entry_id === entry.id && call.provider_id === part.id)) continue;
      if (part.name !== "broker" || typeof part.arguments.label !== "string" || Object.keys(part.arguments).length !== 1) {
        throw new Error("unrecognized orphan tool proposal");
      }
      // Existing results without a Core receipt are ambiguous, not permission
      // to run a side effect again.
      const branch = manager.getBranch();
      const later = branch.slice(branch.findIndex((item) => item.id === entry.id) + 1);
      if (later.some((item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolCallId === part.id)) {
        throw new Error("orphan SDK result requires reconciliation");
      }
      const proposed = store.propose(manager, part.id, { label: part.arguments.label }, config.generation, config.now, entry.id);
      if (proposed.state === "pending") await waitForApproval(proposed.id);
    }
  }
  for (let call of store.calls()) {
    resultEntry(call); // validates the persisted source before any action
    if (call.state === "pending") throw new Error("approval required before recovery");
    if (call.state === "ready") {
      call = store.execute(call.id, config.generation);
      await checkpoint("core-result");
    }
    if (call.result && !resultEntry(call)) {
      manager.appendMessage({ role: "toolResult", toolCallId: call.provider_id, toolName: "broker",
        content: [{ type: "text", text: call.result }], isError: call.state === "cancelled", timestamp: config.now });
      projection.save(manager);
      await checkpoint("sdk-result");
    }
    confirmResults();
  }
}
async function waitForApproval(callId: string): Promise<void> {
  const approved = new Promise<void>((resolve) => {
    const listener = (command: WorkerCommand) => {
      if (command.type !== "approved" || command.callId !== callId) return;
      process.off("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
  await checkpoint("approval-wait");
  await approved;
}
async function projectPending(): Promise<void> {
  store.assertRun(config.generation);
  for (const input of store.pendingInputs()) {
    if (!inputEntry(input)) manager.appendCustomMessageEntry("nex.input", input.text, false, { inputId: input.id, hash: input.hash, seq: input.seq });
    projection.save(manager);
    await checkpoint("input-projected");
    confirmInputs();
  }
}

async function main(): Promise<void> {
  store.assertRun(config.generation);
  // Resolve completed tools before adding inputs so providers never see an
  // input interleaved between an assistant tool call and its result.
  await restoreCalls();
  await projectPending();
  const settled = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "nex.settled").at(-1);
  if (settled?.type === "custom") {
    const data = settled.data as { requestId: number; ids: string[] };
    store.settle(data.requestId, data.ids, config.generation);
  }
  if (store.pendingInputs().length === 0 && store.finish(store.task()!.version, config.generation)) return;

  writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("p0-recovery", { name: "P0 recovery", baseUrl: `${config.origin}/v1`, apiKey: "synthetic-key", api: "openai-completions",
    models: [{ id: "p0-recovery", name: "P0 recovery", api: "openai-completions", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] });
  const model = runtime.getModel("p0-recovery", "p0-recovery");
  if (!model) throw new Error("fixture model missing");
  const broker = defineTool({ name: "broker", label: "Broker", description: "Transactional synthetic side effect", parameters: Type.Object({ label: Type.String() }),
    execute: async (providerId, params) => {
      projection.save(manager); // persist assistant entry before accepting its call
      await checkpoint("assistant-projected");
      const proposed = store.propose(manager, providerId, params, config.generation, config.now);
      if (proposed.state === "pending") {
        // The supervisor owns worker termination, so abort cannot manufacture an
        // SDK error result for a still-pending approved-later call.
        await waitForApproval(proposed.id);
      }
      const call = store.execute(proposed.id, config.generation);
      await checkpoint("core-result");
      return { content: [{ type: "text", text: call.result! }], details: { callId: call.id } };
    } });
  const settingsManager = SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", defaultProjectTrust: "always",
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const loader = new DefaultResourceLoader({ cwd: work, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Use only the broker tool. Follow the user's input." });
  await loader.reload();
  const openSession = async () => (await createAgentSession({ cwd: work, agentDir, model, modelRuntime: runtime, sessionManager: manager,
    settingsManager, resourceLoader: loader, noTools: "all", tools: ["broker"], customTools: [broker], thinkingLevel: "off" })).session;
  session = await openSession();

  process.on("message", (command: WorkerCommand) => {
    if (command.type !== "steer") return;
    void (async () => {
      store.assertRun(config.generation);
      for (const input of store.pendingInputs()) {
        if (inputEntry(input) || queued.has(input.id)) continue;
        queued.add(input.id);
        // This adapter owns the low-level continue loop. Use the matching
        // public Agent queue, not AgentSession's separate prompt lifecycle.
        session!.agent.steer({ role: "custom", customType: "nex.input", content: input.text, display: false,
          details: { inputId: input.id, hash: input.hash, seq: input.seq }, timestamp: config.now });
      }
      send({ checkpoint: "steer-queued" });
    })().catch((error: unknown) => { send({ error: String(error) }); process.exitCode = 1; });
  });

  for (;;) {
    await session.agent.continue();
    projection.save(manager);
    confirmInputs();
    confirmResults();
    const last = manager.buildSessionContext().messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error("model did not finish successfully");
    manager.appendCustomEntry("nex.settled", { requestId, ids: requestInputs });
    projection.save(manager);
    await checkpoint("turn-settled");
    store.settle(requestId, requestInputs, config.generation);
    const expectedVersion = store.task()!.version;
    await checkpoint("before-finish");
    if (store.finish(expectedVersion, config.generation)) break;
    // Inputs accepted at the finish boundary are durable even if no steering
    // notification arrived. Rebuild from the projection and process them.
    session.agent.clearAllQueues();
    session.dispose();
    await projectPending();
    session = await openSession();
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = createFixtureFetch(config.origin, async (input, init) => {
  store.assertRun(config.generation);
  projection.save(manager);
  if (store.calls().some((call) => call.result && !call.sdk_entry && resultEntry(call))) await checkpoint("sdk-result");
  confirmInputs();
  confirmResults();
  requestInputs = store.pendingInputs().filter((row) => inputEntry(row)).map((row) => row.id);
  requestId = store.beginRequest(config.generation, requestInputs);
  await checkpoint("model-request");
  store.assertRun(config.generation);
  return originalFetch(input, init);
});
try {
  await main();
  send({ done: true });
} catch (error) {
  send({ error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  session?.dispose();
  globalThis.fetch = originalFetch;
  projection.close();
  store.close();
  process.disconnect?.();
}
