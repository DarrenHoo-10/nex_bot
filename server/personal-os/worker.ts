import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { ModelPermit, RuntimeInput, WorkerConfig, WorkerEvent, WorkerReply } from "./contracts.ts";
import { modelConnectionError } from "./model-errors.ts";
import { modelInputBudget } from "./model-limits.ts";
import { brokerDescription, brokerParameters } from "./broker-tool.ts";
import { isImagePart, tokens } from './token-estimate.ts';
import { CONTEXT_OVERHEAD, digestCandidates, dropStaleSystemEntries, editedTargets, entryPage, entryText, episodeStart, foldable, hygieneScope, imageCandidates, reductionLimits, systemMessage, systemPromptText, tailBudgetFor, tailCut, triggerLine } from './context-tools.ts';
import { applyRequestPrompt } from './request-prompt.ts';

let session: AgentSession | undefined;
const replies = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
const projected = new Set<string>();
let activeInvoke: string | undefined;
// Estimate of the payload most recently sent; reported with its receipt so Core can calibrate.
let requestEstimate: number | undefined;
let purpose: "answer" | "compact" = "answer";
let config: WorkerConfig;
let manager: SessionManager;
let started = false;
// The turn-start digest of older tool results runs on the first model boundary of a worker only.
let hygieneDone = false;
// The episode boundary is closed at the first model boundary of a worker only.
let episodeDone = false;
// Set while a background maintenance run is reducing; a stop request aborts it.
let maintenance: AbortController | undefined;
function send(event: WorkerEvent) { process.send?.(event); }
function snapshot(): FileEntry[] {
  const header = manager.getHeader();
  if (!header) throw new Error("Session header missing");
  return [header, ...manager.getEntries()];
}
function rpc(event: WorkerEvent): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    replies.set(requestId, { resolve, reject });
    send({ ...event, requestId });
  });
}
function project(input: RuntimeInput, steering: boolean) {
  if (projected.has(input.id)) return;
  projected.add(input.id);
  const entry = manager.getBranch().find((e) => e.type === "custom_message" && e.customType === "nex.input" && (e.details as { inputId?: string } | undefined)?.inputId === input.id);
  if (entry?.type === "custom_message") {
    if (entry.content !== input.text || (entry.details as { hash: string }).hash !== input.hash) throw new Error("Input identity conflict");
    return;
  }
  const details = { inputId: input.id, hash: input.hash, seq: input.seq };
  if (steering && session) session.agent.steer({ role: "custom", customType: "nex.input", content: input.text, display: false, details, timestamp: Date.now() });
  else manager.appendCustomMessageEntry("nex.input", input.text, false, details);
}
async function execute(providerId: string, entryId: string, args: Record<string, unknown>) {
  return rpc({ type: "tool", providerId, entryId, args, entries: snapshot(), inputs: [...projected] });
}
function toolContent(result: unknown): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const value = result && typeof result === "object" ? result as { images?: { type: "image"; data: string; mimeType: string }[] } : {};
  const { images, ...metadata } = value;
  return [{ type: "text", text: JSON.stringify(images ? metadata : result) }, ...(images ?? []).filter((image) => ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) && typeof image.data === "string").map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
}
/**
 * The reduction pipeline of one model boundary: turn-start digests of older tool results, then, when over
 * the trigger line, paging of oversized results, a turn summary and result summaries, down to the target.
 * Used by every answering request and, with maintain, by background maintenance (no input, no answer).
 */
async function reduceContext(signal:AbortSignal|undefined,maintain:boolean){
  // Re-project at EVERY model boundary, including tool continuations. The
  // append-only transcript retains original tool outputs and old summaries.
  let messages=manager.buildSessionContext().messages;
  const clean=(input:typeof messages)=>{
    // Capacity, not message age or individual result length, controls eviction.
    // Compaction omits old system entries; keep counting the current prompt.
    return [systemMessage(config.systemPrompt),...input.filter(message=>message.role!=='system')];
  };
  messages=clean(messages);
  const overhead=CONTEXT_OVERHEAD;
  // The volatile block is injected at the request boundary but still takes window space.
  const volatileTokens=tokens(config.volatilePrompt),promptTokens=tokens(config.systemPrompt)+volatileTokens;
  const count=()=>tokens(messages)+overhead+volatileTokens;
  // The working budget, not the window, is the normal trigger: reduction starts at the budget and,
  // once started, continues down to half of it (hysteresis) so it does not run on every turn.
  // inputBudget stays the hard limit (window minus output room).
  const limits=reductionLimits(config),{inputBudget,target,calibration,ceiling}=limits;
  // Calibration scales only the count compared with the budget lines. Capacity checks
  // (summarizer windows, paging budgets, the window check at fetch) stay on the raw count().
  // A skewed receipt must never strand a request that only reduction could make sendable, so
  // the raw count reaching 90% of the window starts reduction too and keeps it going.
  // Background maintenance starts earlier, leaving room for the next turn's input.
  const line=triggerLine(limits,maintain),over=()=>count()*calibration>=line||count()>=ceiling;
  const above=()=>count()*calibration>target||count()>=ceiling;
  // Only a request that cannot fit the input budget is an error; missing the working target is not.
  const unfit=()=>count()*calibration>=inputBudget||count()>=ceiling;
  // The summarizer shares this window and needs room for its instruction and
  // output. Every compact request targets half of it; the carried summary and
  // a single capped item can still exceed that softly without reaching the limit.
  // Summarizer requests go to the tidy-up model, so its window, not the chat model's, sizes them.
  const tidyWindow=config.tidyWindow??config.contextWindow,summaryBudget=Math.floor(tidyWindow*.5),itemBudget=Math.floor(summaryBudget*.8);
  const page=(entry:FileEntry)=>{
    const limit=Math.max(1,Math.min(12000,Math.floor(inputBudget*.1)));
    manager.appendContextEdit(entry.id,{content:[{type:'text',text:JSON.stringify({notice:'工具原文超过本次输入容量，以下为分页内容，并非完整结果。用 memory.search(query,offset,limit) 继续读取。',query:`entry:${entry.id}`,...entryPage(entry.id,entryText(entry),0,limit)})}]});
  };
  type ToolResult=Extract<(typeof messages)[number],{role:'toolResult'}>;
  // Replace one tool body with a short summary; the original entry stays intact.
  const summarizeResult=async(entry:FileEntry,message:ToolResult,imageMarker='[图片]')=>{
    const source=[{ref:`entry:${entry.id}`,role:message.role,status:message.isError?'failed':'succeeded',content:message.content.map(part=>isImagePart(part)?{type:'text',text:imageMarker}:part)}];
    // Alone with a 1024-token answer, a body may use most of the window.
    if(tokens(source)>Math.floor(tidyWindow*.8)){page(entry);return;}
    const result=await rpc({type:'compact',summaryKind:'result',entries:snapshot(),inputs:[...projected],text:JSON.stringify(source),firstEntry:entry.id,lastEntry:entry.id,contextTokens:count(),summaryMaxTokens:1024}) as {summary:string;checkpoint:string};
    if(signal?.aborted)throw new Error('压缩已取消');
    const content=[{type:'text' as const,text:`工具结果摘要（${message.isError?'失败':'完成'}），原文 entry:${entry.id}：\n${result.summary}`}];
    if(tokens(content)<tokens(message.content))manager.appendContextEdit(entry.id,{content});
  };
  type SourceItem={ref:string;role:string;content:unknown};
  type Folded={summary:string;checkpoint:string;episode?:string};
  // What the summarizer reads for a run of context entries: inputs, a leading summary and the projected
  // messages. It reads text; image bytes stay in the original entry.
  const sourceOf=(earlier:FileEntry[])=>{
    const textOnly=(content:unknown)=>Array.isArray(content)?content.map(part=>isImagePart(part)?{type:'text',text:'[图片]'}:part):content;
    const projection=new Map(manager.buildSessionProjection().entries.map(item=>[item.sourceEntry.id,item.messages]));
    return earlier.flatMap<SourceItem>((entry,index)=>{
      const ref=`entry:${entry.id}`;
      if(entry.type==='custom_message')return [{ref,role:'user',content:textOnly(entry.content)}];
      if(entry.type==='compaction'&&index===0)return [{ref,role:'summary',content:entry.summary}];
      if(entry.type==='message'&&entry.message.role!=='system')return (projection.get(entry.id)??[]).map(message=>({ref,role:message.role,content:'content' in message?textOnly(message.content):JSON.stringify(message)}));
      return [];
    });
  };
  // Summarize in tidy-model-window-sized batches, carrying the running summary forward; an item too large
  // for any batch is cut with its reference. The last request has the given kind (an episode archive is
  // produced by the final request, which reads the running summary instead of re-reading earlier batches).
  const foldBatches=async(source:SourceItem[],finalKind:'history'|'episode',episode?:WorkerEvent['episode'])=>{
    const items=source.map(item=>tokens(item)<=itemBudget?item:{...item,content:JSON.stringify(item.content).slice(0,Math.floor(itemBudget/1.5))+`…[已截断，原文 ${item.ref}]`});
    let result:Folded|undefined;
    for(let start=0;start<items.length;){
      const batch:SourceItem[]=result?[{ref:`checkpoint:${result.checkpoint}`,role:'summary',content:result.summary}]:[];
      let size=tokens(batch),end=start;
      while(end<items.length&&(end===start||size+tokens(items[end])<=summaryBudget)){size+=tokens(items[end]);batch.push(items[end++]);}
      const last=end>=items.length;
      result=await rpc({type:'compact',summaryKind:last?finalKind:'history',...(last&&episode?{episode}:{}),entries:snapshot(),inputs:[...projected],text:JSON.stringify(batch),firstEntry:items[0].ref.slice(6),lastEntry:items[end-1].ref.slice(6),contextTokens:count()}) as Folded;
      if(signal?.aborted)throw new Error('压缩已取消');
      start=end;
    }
    if(!result)throw new Error('压缩来源缺失');
    return result;
  };
  // Episode boundary. When Core says the input of this run opens a new episode (a 6 h gap or an explicit new
  // topic), everything before that input is archived in one structured summary, and a compaction keeps only
  // the short "上一段要点", leaving the new episode a clean working context. Archiving never fails the turn:
  // invalid output, a failed summarizer call or a missing source leaves the episode open and the turn goes on.
  // Only a cancellation propagates. Answers only: a maintenance run has no input and so no boundary.
  const closeEpisode=async()=>{
    if(episodeDone||maintain||!config.episode)return;
    episodeDone=true;
    try{
      const opening=manager.getBranch().find(entry=>entry.type==='custom_message'&&entry.customType==='nex.input'&&(entry.details as {inputId?:string}|undefined)?.inputId===config.episode!.inputId);
      if(!opening)return;
      const entries=manager.buildContextEntries(),index=entries.findIndex(entry=>entry.id===opening.id),earlier=entries.slice(0,Math.max(index,0));
      if(index<=0||!foldable(earlier,new Map(manager.buildSessionProjection().entries.map(item=>[item.sourceEntry.id,item.messages]))))return;
      const source=sourceOf(earlier);
      if(!source.length)return;
      const time=(entry:FileEntry|undefined)=>{const value=entry&&entry.type!=='session'?Date.parse(entry.timestamp):NaN;return Number.isFinite(value)?value:Date.now();};
      const all=snapshot(),firstId=episodeStart(all,earlier[0]);
      const result=await foldBatches(source,'episode',{firstEntry:firstId,lastEntry:earlier.at(-1)!.id,startedAt:time(all.find(entry=>entry.type!=='session'&&entry.id===firstId)),endedAt:time(earlier.at(-1))});
      manager.appendCompaction(result.summary,opening.id,count(),{checkpoint:result.checkpoint,sourceFirst:earlier[0].id,sourceLast:earlier.at(-1)!.id,episode:result.episode});
      await rpc({type:'snapshot',entries:snapshot()});
      messages=clean(manager.buildSessionContext().messages);
    }catch(error){
      if(signal?.aborted)throw error;
    }
  };
  await closeEpisode();
  // Steady-state hygiene, independent of budget pressure: when a new turn starts, results of turns
  // older than the latest completed one no longer sit in context in full. Large bodies get their own
  // summary and images become text markers; originals stay retrievable as entry:<id>. The current
  // turn and the latest completed turn (for follow-ups such as "continue comparing that list") are kept.
  // A maintenance run has no input of its own and keeps the latest completed turn, as the next turn will.
  if(!hygieneDone){
    hygieneDone=true;
    const items=manager.buildSessionProjection().entries,older=hygieneScope(items,maintain);
    if(older){
      const edited=editedTargets(manager.getBranch());
      const calls=new Map<string,Record<string,unknown>>();
      for(const item of items)for(const message of item.messages)if(message.role==='assistant')for(const part of message.content)if(part.type==='toolCall')calls.set(part.id,part.arguments);
      // attachment.read results carry the attachment only in the call; other images have no durable id.
      const imageMarker=(toolCallId:string)=>{const call=calls.get(toolCallId),id=call?.action==='attachment.read'?call.attachmentId:undefined;return typeof id==='string'&&id?`[图片 attachment:${id}]`:'[图片]';};
      let changed=false;
      try{
        for(const item of digestCandidates(items,older,edited)){
          const entry=item.sourceEntry,message=item.messages[0];
          if(message?.role!=='toolResult')continue;
          const before=manager.getBranch().length;
          await summarizeResult(entry,message,imageMarker(message.toolCallId));
          if(manager.getBranch().length!==before){changed=true;await rpc({type:'snapshot',entries:snapshot()});}
        }
      }catch(error){
        // A failed digest must not fail the user's turn; originals stay and pressure handling reports real problems.
        if(signal?.aborted)throw error;
      }
      for(const item of imageCandidates(manager.buildSessionProjection().entries,older)){
        const entry=item.sourceEntry,message=item.messages[0];
        if(!message||(message.role!=='user'&&message.role!=='toolResult'&&message.role!=='custom')||!Array.isArray(message.content))continue;
        const marker=message.role==='toolResult'?imageMarker(message.toolCallId):'[图片]';
        manager.appendContextEdit(entry.id,{content:message.content.map(part=>isImagePart(part)?{type:'text' as const,text:marker}:part) as never});
        changed=true;
      }
      if(changed){await rpc({type:'snapshot',entries:snapshot()});messages=clean(manager.buildSessionContext().messages);}
    }
  }
  // Decided once per call: a reduction that starts runs every stage down to the target.
  const reducing=over();
  if(reducing){
    // A single oversized text result cannot be sent to the summarizer either.
    // Page only when under pressure and unable to fit, keeping the raw entry.
    const resultBudget=inputBudget-overhead-promptTokens-tokens(brokerParameters)-tokens(brokerDescription)-4096;
    for(const {sourceEntry,messages:projectedMessages} of manager.buildSessionProjection().entries){
      const message=projectedMessages[0];
      if(sourceEntry.type!=='message'||message?.role!=='toolResult'||tokens(message.content)<=resultBudget)continue;
      page(sourceEntry);
    }
    await rpc({type:'snapshot',entries:snapshot()});
    messages=clean(manager.buildSessionContext().messages);
  }
  if(reducing&&above()){
    const entries=manager.buildContextEntries();
    // Use the same conservative estimator for both trigger and retained tail.
    // Cuts are only at user turns, never between a tool call and its result.
    const index=tailCut(entries,tailBudgetFor(limits,promptTokens));
    const first=entries[index];
    const earlier=entries.slice(0,index);
    // A leading summary alone is not folded into a summary of itself.
    if(first && foldable(earlier,new Map(manager.buildSessionProjection().entries.map(item=>[item.sourceEntry.id,item.messages])))){
      // A backlog (for example, history accepted under earlier projection
      // rules) can far exceed the window. Dominant tool bodies get their own
      // summaries first so the turn summary keeps the rest of the history.
      const edited=new Set(manager.getBranch().flatMap(entry=>entry.type==='context_edit'?[entry.targetId]:[]));
      const before=new Set(earlier.map(entry=>entry.id));
      for(const {sourceEntry,messages:projectedMessages} of manager.buildSessionProjection().entries){
        const message=projectedMessages[0];
        if(!before.has(sourceEntry.id)||sourceEntry.type!=='message'||message?.role!=='toolResult'||edited.has(sourceEntry.id)||tokens(message.content)<=summaryBudget/4)continue;
        await summarizeResult(sourceEntry,message);
        await rpc({type:'snapshot',entries:snapshot()});
      }
      messages=clean(manager.buildSessionContext().messages);
      const source=sourceOf(earlier);
      // Core persists source snapshot and checkpoint before the worker changes
      // projection. Failure leaves the preceding projection intact.
      if(source.length){
        const result=await foldBatches(source,'history');
        manager.appendCompaction(result.summary,first.id,count(),{checkpoint:result.checkpoint,sourceFirst:earlier[0].id,sourceLast:earlier.at(-1)!.id});
        await rpc({type:'snapshot',entries:snapshot()});
        messages=clean(manager.buildSessionContext().messages);
      }
    }
  }
  if(reducing&&above()){
    // Preserve the user's exact inputs, the newest tool-call group, and any
    // explicitly retrieved originals in this turn. Only older result bodies
    // become useful summaries; their call/result metadata remains paired.
    const projectedEntries=manager.buildSessionProjection().entries;
    const latestCall=projectedEntries.findLast(item=>item.messages.some(message=>message.role==='assistant'&&message.content.some(part=>part.type==='toolCall')));
    const latestIndex=latestCall?projectedEntries.indexOf(latestCall):projectedEntries.length;
    const turnStart=projectedEntries.findLastIndex(item=>item.sourceEntry.type==='custom_message'&&item.sourceEntry.customType==='nex.input'||item.messages.some(message=>message.role==='user'));
    const edited=new Set(manager.getBranch().flatMap(entry=>entry.type==='context_edit'?[entry.targetId]:[]));
    const retrieved=new Set(projectedEntries.slice(turnStart+1).flatMap(item=>item.messages.flatMap(message=>message.role==='assistant'?message.content.flatMap(part=>part.type==='toolCall'&&part.arguments.action==='memory.search'&&String(part.arguments.query).startsWith('entry:')?[part.id]:[]):[])));
    for(const item of projectedEntries.slice(0,maintain?Math.min(latestIndex,Math.max(turnStart,0)):latestIndex)){
      if(!above())break;
      const entry=item.sourceEntry,message=item.messages[0];
      if(entry.type!=='message'||message?.role!=='toolResult'||edited.has(entry.id)||retrieved.has(message.toolCallId)||tokens(message.content)<2048)continue;
      await summarizeResult(entry,message);
      await rpc({type:'snapshot',entries:snapshot()});
      messages=clean(manager.buildSessionContext().messages);
    }
  }
  return {messages,count,unfit,calibration,inputBudget};
}
// Background maintenance: the reduction a turn would start with, run ahead of the turn.
async function runMaintenance(){
  maintenance=new AbortController();
  const entries=config.entries?.length;
  if(entries)await reduceContext(maintenance.signal,true);
  await rpc({type:"done",entries:entries?snapshot():undefined,inputs:[],text:""});
}

async function main(value: WorkerConfig) {
  config = value;
  mkdirSync(config.dir, { recursive: true });
  const cwd = path.join(config.dir, "work"), agentDir = path.join(config.dir, "pi");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  manager = SessionManager.inMemory(cwd, undefined, config.entries && dropStaleSystemEntries(config.entries));
  if (config.mode === "maintain") { await runMaintenance(); return; }
  if(!config.entries?.length)for(const item of config.history??[])manager.appendCustomMessageEntry('nex.history',JSON.stringify({historical:true,...item}),false);
  const settled = manager.getEntries().at(-1);
  if (settled?.type === "custom" && settled.customType === "nex.settled") {
    const data = settled.data as { inputs: string[]; text: string };
    if (config.inputs.every((input) => data.inputs.includes(input.id))) {
      await rpc({ type: "done", entries: snapshot(), inputs: data.inputs, text: data.text });
      process.disconnect?.(); return;
    }
  }
  // Replay only proposals lacking a result in their original source scope.
  const branch = manager.getBranch();
  for (let index = 0; index < branch.length; index++) {
    const source = branch[index];
    if (source.type !== "message" || source.message.role !== "assistant") continue;
    for (const part of source.message.content) {
      if (part.type !== "toolCall") continue;
      const later = branch.slice(index + 1);
      const next = later.findIndex((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((p) => p.type === "toolCall" && p.id === part.id));
      const range = next < 0 ? later : later.slice(0, next);
      if (range.some((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === part.id)) continue;
      if (part.name !== "broker") throw new Error("Unrecognized recovered tool");
      const result = await execute(part.id, source.id, part.arguments);
      manager.appendMessage({ role: "toolResult", toolCallId: part.id, toolName: "broker", content: toolContent(result), isError: !!(result as { isError?: boolean; error?: string })?.isError || !!(result as { error?: string })?.error, timestamp: Date.now() });
    }
  }
  // Public projection API: structured system messages are replayed by the SDK.
  // continue() deliberately skips AgentSession.prompt's prompt preparation.
  // Only the stable prompt is projected, and only when it changed; the volatile block is injected per request.
  if (systemPromptText(manager.getBranch().findLast((e) => !!systemPromptText(e))) !== config.systemPrompt) manager.appendMessage({ role: "system", content: config.systemPrompt, timestamp: Date.now() });
  for (const input of config.inputs) project(input, false);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const api = config.provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  runtime.registerProvider("nex", { name: "NexBot API", apiKey: config.apiKey, baseUrl: config.endpoint, api,
    models: [{ id: config.model, name: config.model, api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens }] });
  const model = runtime.getModel("nex", config.model);
  if (!model) throw new Error("Model registration failed");
  const broker = defineTool({ name: "broker", label: "Core Broker", description: brokerDescription,
    parameters: brokerParameters,
    execute: async (providerId, args) => {
      const source = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((p) => p.type === "toolCall" && p.id === providerId));
      if (!source) throw new Error("Tool proposal source missing");
      const result = await execute(providerId, source.id, args);
      return { content: toolContent(result), details: { source: "core" }, isError: !!(result as { isError?: boolean; error?: string })?.isError || !!(result as { error?: string })?.error };
    } });
  const inputBudget = modelInputBudget(config.contextWindow, config.maxOutputTokens);
  const settings = SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false, reserveTokens: config.contextWindow - inputBudget, keepRecentTokens: Math.min(20_000, Math.floor(inputBudget / 3)) }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: config.systemPrompt });
  await loader.reload();
  session = (await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all", tools: ["broker"], customTools: [broker], thinkingLevel: "off" })).session;
  const transform=session.agent.transformContext;
  session.agent.transformContext=async (_messages,signal)=>{
    const state=await reduceContext(signal,false);
    // Only a request that cannot fit the input budget is an error; missing the working target is not.
    if(state.unfit())throw new Error(`当前用户要求与保留资料仍超过输入预算（估算 ${state.count()}${state.calibration===1?'':`，校准后 ${Math.round(state.count()*state.calibration)}`} / ${state.inputBudget} Token）。原文已保留，请分段读取或增大模型窗口。`);
    return transform?transform(state.messages,signal):state.messages;
  };
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") send({ type: "delta", text: event.assistantMessageEvent.delta });
    if (event.type === "message_end" && event.message.role === "assistant") {
      send({ type: "snapshot", invokeId: activeInvoke, inputTokens: event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite, estimatedTokens: requestEstimate, cacheRead:event.message.usage.cacheRead,cacheWrite:event.message.usage.cacheWrite,outputTokens: event.message.usage.output, modelStatus: event.message.stopReason === "error" ? "failed" : event.message.stopReason === "aborted" ? "cancelled" : "succeeded" });
    }
  });
  const originalFetch = globalThis.fetch, endpoint = new URL(config.endpoint);
  let httpFailure: { status: number; address: string } | undefined;
  let requestFailure: Error | undefined;
  globalThis.fetch = async (input, init) => {
    // A rejected request has no invoice. Never let the SDK's error event
    // overwrite the preceding successful request's receipt or usage.
    activeInvoke = undefined;
    requestEstimate = undefined;
    httpFailure = undefined;
    requestFailure = undefined;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let sending = false;
    try {
      if (url.origin !== endpoint.origin || url.username || url.password || !url.pathname.startsWith(endpoint.pathname.replace(/\/$/, "") + "/")) throw new Error("Blocked model network destination");
      const permit = await rpc({ type: "request", entries: snapshot(), inputs: [...projected], purpose }) as ModelPermit;
      activeInvoke = permit.invokeId;
      let body = init?.body;
      if (purpose === "answer") {
        if (typeof body !== "string") throw new Error("Unsupported model request body");
        const payload = JSON.parse(body);
        // Refresh at the final request boundary, including continuation after a
        // tool/approval. Replacing old Core system messages also prevents SDK
        // projections/compaction from restoring an obsolete contact identity.
        applyRequestPrompt(config.provider, payload, permit);
        const estimated=tokens(payload);
        requestEstimate=estimated;
        const available=Math.floor(config.contextWindow-estimated-256);
        if(available<256)throw new Error('当前请求超出上下文窗口，原文已保留');
        if(config.provider==='anthropic')payload.max_tokens=Math.min(Number(payload.max_tokens??config.maxOutputTokens),available);
        else if(payload.max_completion_tokens!==undefined)payload.max_completion_tokens=Math.min(Number(payload.max_completion_tokens),available);
        else payload.max_tokens=Math.min(Number(payload.max_tokens??config.maxOutputTokens),available);
        body=JSON.stringify(payload);
      }
      sending = true;
      const response = await originalFetch(input, { ...init, body, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
      if (!response.ok) httpFailure = { status: response.status, address: url.origin + url.pathname };
      return response;
    } catch (error) {
      // Provider SDKs flatten fetch exceptions (including Core's budget or
      // policy rejection) to "Connection error." Preserve the real boundary.
      requestFailure = sending ? modelConnectionError(error, url) : error instanceof Error ? error : new Error("Core 拒绝了模型请求");
      throw error;
    }
  };
  try {
    await session.agent.continue();
    const last = manager.buildSessionContext().messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") {
      const detail = last?.role === "assistant" ? last.errorMessage ?? "Model did not finish" : "Model did not finish";
      if (httpFailure?.status === 404) throw new Error(`模型服务返回 404。请求地址：${httpFailure.address}。请检查 API 基础地址（OpenAI 兼容地址通常包含 /v1）、API 协议和模型 ID。服务响应：${detail}`);
      throw requestFailure ?? new Error(detail);
    }
    const result = last.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    // Only entries actually consumed by the SDK are acknowledged, not the
    // volatile steering queue. New input arriving at this boundary stays pending.
    const inputs = manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "nex.input").map((e) => (e as { details?: { inputId?: string } }).details?.inputId).filter((x): x is string => typeof x === "string");
    manager.appendCustomEntry("nex.settled", { inputs, text: result });
    // Wait for Core's durable acknowledgement before closing IPC. A large
    // snapshot can otherwise still be buffered when the process disconnects.
    await rpc({ type: "done", entries: snapshot(), inputs, text: result });
  } catch (error) { throw requestFailure ?? error; }
  finally { globalThis.fetch = originalFetch; session.dispose(); }
}
process.on("message", (message: WorkerReply) => {
  if (message.type === "start" && message.config && !started) {
    started = true;
    void main(message.config).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      send({ type: "error", error: config?.apiKey ? detail.split(config.apiKey).join("[redacted]") : detail });
    }).finally(() => process.disconnect?.());
  }
  if (message.type === "reply" && message.requestId) {
    const pending = replies.get(message.requestId); replies.delete(message.requestId);
    if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
  }
  if (message.type === "steer" && message.input) project(message.input, true);
  if (message.type === "stop") { session?.agent.abort(); maintenance?.abort(); for (const p of replies.values()) p.reject(new Error("Cancelled")); }
});
process.once("disconnect", () => { session?.agent.abort(); maintenance?.abort(); for (const p of replies.values()) p.reject(new Error("Core disconnected")); process.exit(0); });
