// Built-in runtime HarnessDriver implementations for Claude Code, Codex, ZCode
// and Antigravity CLI (Adapter + Strategy pattern).
//
// CliAgentBridge delegates engine-specific runtime behaviour (probing, ACP/DB
// reading, inbox/daemon/host routing, skills/models discovery, local-terminal
// handoff and pending request ownership) through these drivers. A future
// terminal+JSONL harness can register a minimal driver (or none at all) and
// inherit the bridge's shared terminal, worktree, watch and search templates.
import os from "node:os";
import path from "node:path";
import {
  cliRef,
  type CliEngine,
  type CliErrorCode,
  type CliLaunchOptions,
  type CliOpArgs,
  type CliPermissionMode,
  type CliSessionRef,
} from "../../../shared/cli-agents.ts";
import type { AgyRuntime } from "./agy.ts";
import { supportsAgyAcp } from "./agy-native.ts";
import { archiveClaudeSession, deleteClaudeSession } from "./claude.ts";
import { DaemonError, codexSkills, manageCodexThread, type CodexDaemons } from "./codex-daemon.ts";
import type { CodexDesktopQueue } from "./codex-desktop-queue.ts";
import type { SessionDiscovery } from "./discovery.ts";
import { harnessFor, type HarnessDriver, type HarnessWatchSource } from "./harness.ts";
import { InboxError, sendToInbox } from "./inbox.ts";
import { validateCwd } from "./launch.ts";
import { claudeSkills } from "./skills.ts";
import type { ZcodeHostChannel } from "./zcode.ts";
import type { ZcodeRuntime } from "./zcode-runtime.ts";

export interface HarnessDriverErrorFactory {
  (code: CliErrorCode, message?: string): Error;
}

export interface HarnessDriverHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly homedir: string | undefined;
  readonly discovery: SessionDiscovery;
  readonly agy: AgyRuntime;
  readonly zcode: ZcodeRuntime;
  readonly codexDaemons: CodexDaemons;
  readonly codexDesktopQueue: Pick<CodexDesktopQueue, "refresh" | "supports" | "send"> | undefined;
  readonly zcodeHomes: string[] | undefined;
  readonly zcodeHost: ZcodeHostChannel | null | undefined;
  readonly inboxConfirmMs: number | undefined;
  readonly shouldProbeAgy: boolean;
  readonly shouldProbeZcode: boolean;
  fail: HarnessDriverErrorFactory;
  probeCli(engine: CliEngine): Promise<{ available: boolean; version: string | null }>;
  findCli(engine: CliEngine): Promise<string | null>;
  addressFor(ref: string): string | null;
  firstCodexGate(address: string): { confirmed: boolean } | undefined;
  awaitRow(ref: CliSessionRef, ms: number): Promise<void>;
  scheduleRefresh(): void;
  setAgyNeedsUpdate(value: boolean): void;
}

function launchOptionsOf(args: CliLaunchOptions, fallback?: CliPermissionMode): CliLaunchOptions {
  const permissions = args.permissions ?? fallback;
  return {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  };
}

export function createDefaultHarnessDrivers(host: HarnessDriverHost): Map<CliEngine, HarnessDriver> {
  const env = () => host.env ?? process.env;
  const home = () => host.homedir ?? os.homedir();

  const claudeDriver: HarnessDriver = {
    id: "claude",
    async sendOutside(args, row, steer = false) {
      const route = host.discovery.routeFor(args.ref);
      if (!route || route.via !== "inbox" || row.sendVia !== "inbox") return null;
      if (row.state === "stopped") throw host.fail("stopped");
      const result = await sendToInbox(
        { configDir: route.configDir, pid: route.pid, socketPath: route.socketPath, sessionId: route.sessionId },
        args.text,
        {
          platform: host.platform,
          transcript: host.discovery.transcriptFor(args.ref),
          state: row.state,
          steer,
          ...(host.inboxConfirmMs === undefined ? {} : { confirmMs: host.inboxConfirmMs }),
        },
      );
      return { turn: 0, started: false, delivery: result.delivery, ...(result.waiting ? { waiting: true } : {}) };
    },
    async steer(args, row, managedAddress) {
      const route = host.discovery.routeFor(args.ref);
      if (managedAddress) {
        if (route?.via === "inbox" && !args.text.trimStart().startsWith("/")) {
          try {
            const receipt = await sendToInbox(route, args.text, {
              steer: true,
              platform: host.platform,
              state: row.state,
              transcript: host.discovery.transcriptFor(args.ref),
              ...(host.inboxConfirmMs === undefined ? {} : { confirmMs: host.inboxConfirmMs }),
            });
            return { accepted: true, delivery: receipt.delivery };
          } catch (error) {
            // No authenticated connection was established. A partial write or a
            // missing receipt must never cause a second submission.
            if (!(error instanceof InboxError) || (error.code !== "not_in_terminal" && error.code !== "stopped")) throw error;
          }
        }
        return null;
      }
      if (route?.via === "inbox" && row.sendVia === "inbox") {
        if (row.state !== "running") throw host.fail("turn_changed");
        const sent = await claudeDriver.sendOutside!(args, row, true);
        return { accepted: true, ...(sent?.delivery ? { delivery: sent.delivery } : {}) };
      }
      return null;
    },
    async interruptOutside(args, row) {
      const route = host.discovery.routeFor(args.ref);
      if (!route || route.via !== "inbox" || row.sendVia !== "inbox") return null;
      if (row.state !== "running" && row.state !== "waiting") throw host.fail("turn_changed");
      const result = await sendToInbox(
        { configDir: route.configDir, pid: route.pid, socketPath: route.socketPath, sessionId: route.sessionId },
        "",
        {
          stop: true,
          transcript: host.discovery.transcriptFor(args.ref),
          state: row.state,
          platform: host.platform,
          ...(host.inboxConfirmMs === undefined ? {} : { confirmMs: host.inboxConfirmMs }),
        },
      );
      host.scheduleRefresh();
      return { outcome: result.delivery === "confirmed" ? "stopped" : "unconfirmed" };
    },
    skills(session, cwd) {
      return claudeSkills(session?.configDir || env().CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), cwd);
    },
    async archive(_ref, row, archived) {
      const ok = await archiveClaudeSession(row.configDir || env().CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), row.nativeId, archived, host.discovery.claudeDesktopRoots());
      if (!ok) throw host.fail("not_found");
    },
    async deleteSession(_ref, row) {
      const ok = await deleteClaudeSession(row.configDir || env().CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), row.nativeId, host.discovery.claudeDesktopRoots());
      if (!ok) throw host.fail("not_found");
    },
  };

  const codexDriver: HarnessDriver = {
    id: "codex",
    watchSource(ref): HarnessWatchSource | null {
      const app = host.discovery.appChatFor(ref);
      return app ? { chat: app.chat, db: app.db } : null;
    },
    async sendOutside(args, row) {
      const route = host.discovery.routeFor(args.ref);
      if (route?.via === "codexQueue" && row.sendVia === "inbox" && host.codexDesktopQueue) {
        await host.codexDesktopQueue.send({ home: route.home, threadId: route.threadId, version: route.version, text: args.text });
        return { turn: 0, started: false, delivery: "unconfirmed" };
      }
      if (!route || route.via !== "daemon" || row.sendVia !== "daemon") return null;
      const sent = await host.codexDaemons.send(route.home, route.threadId, args.text);
      return { turn: 0, started: !sent.steered };
    },
    async steer(args, row, managedAddress) {
      // A shared Codex daemon can bind the input to one exact turn even if
      // discovery also knows the address of the CLI's terminal.
      const gate = managedAddress ? host.firstCodexGate(managedAddress) : undefined;
      if ((!gate || gate.confirmed) && host.codexDaemons.threads(row.configDir)?.has(row.nativeId)) {
        return host.codexDaemons.steer(row.configDir, row.nativeId, args.text);
      }
      if (managedAddress) return null;
      const route = host.discovery.routeFor(args.ref);
      if (route?.via === "daemon" && row.sendVia === "daemon") {
        return host.codexDaemons.steer(route.home, route.threadId, args.text);
      }
      return null;
    },
    skills(session, cwd) {
      return codexSkills(
        { codexPath: () => host.findCli("codex"), env: env(), platform: host.platform },
        session?.configDir || env().CODEX_HOME || path.join(home(), ".codex"),
        cwd,
      );
    },
    hasRequest(id) {
      return host.codexDaemons.owns(id);
    },
    async answerRequest(args: CliOpArgs["answer"]) {
      try {
        return { outcome: host.codexDaemons.answer(args) };
      } catch (error) {
        if (error instanceof DaemonError) throw host.fail(error.code, error.code === "not_found" ? "request is closed" : undefined);
        throw error;
      }
    },
    async archive(_ref, row, archived) {
      const codexHome = row.configDir || env().CODEX_HOME || path.join(home(), ".codex");
      await manageCodexThread(
        { codexPath: () => host.findCli("codex"), env: env(), platform: host.platform },
        codexHome,
        archived ? "archive" : "unarchive",
        row.nativeId,
      );
      if (archived) host.codexDaemons.forgetThread(codexHome, row.nativeId);
      host.discovery.invalidateCodex(codexHome);
    },
    async deleteSession(_ref, row) {
      const codexHome = row.configDir || env().CODEX_HOME || path.join(home(), ".codex");
      await manageCodexThread(
        { codexPath: () => host.findCli("codex"), env: env(), platform: host.platform },
        codexHome,
        "delete",
        row.nativeId,
      );
      host.codexDaemons.forgetThread(codexHome, row.nativeId);
      host.discovery.invalidateCodex(codexHome);
    },
    relink() {
      host.codexDaemons.relink();
    },
    close() {
      host.codexDaemons.close();
    },
  };

  const zcodeDriver: HarnessDriver = {
    id: "zcode",
    async probe() {
      if (!host.shouldProbeZcode) return { available: false, version: null };
      return host.zcode.probe();
    },
    watchSource(_ref, row): HarnessWatchSource {
      return { chat: { threadId: row.nativeId }, db: host.zcode };
    },
    read(_ref, row, before, limit) {
      return host.zcode.page(row.nativeId, before ? { before } : {}, limit);
    },
    async start(args, cwd, budget) {
      const id = await host.zcode.start(cwd, launchOptionsOf(args, "full"));
      const ref = cliRef("zcode", id);
      await host.awaitRow(ref, budget - 1000);
      return { ref, cwd };
    },
    async continueSession(args, row) {
      const terminal = host.addressFor(args.ref);
      if (terminal) return { ref: args.ref, terminal };
      await validateCwd(row.cwd, { platform: host.platform, env: host.env });
      await host.zcode.resume(row, launchOptionsOf(args));
      return { ref: args.ref };
    },
    async sendOutside(args, row) {
      if (host.zcode.hasManagedSession(row.nativeId)) {
        return host.zcode.send(row.nativeId, args.text);
      }
      const route = host.discovery.routeFor(args.ref);
      if (route?.via === "host" && row.sendVia === "host") {
        if (!host.zcodeHost) throw host.fail("read_only");
        const result = await host.zcodeHost.submit(route.sessionId, args.text);
        return { turn: 0, started: result.accepted === true };
      }
      throw host.fail(row.liveIn ? "open_elsewhere" : "stopped");
    },
    async steer(args, row, managedAddress) {
      if (managedAddress) return null;
      if (host.zcode.hasManagedSession(row.nativeId)) {
        const result = await host.zcode.send(row.nativeId, args.text, true);
        return { accepted: result.accepted === true, started: result.started };
      }
      const route = host.discovery.routeFor(args.ref);
      if (route?.via === "host" && row.sendVia === "host") {
        if (!host.zcodeHost) throw host.fail("read_only");
        const result = await host.zcodeHost.submit(route.sessionId, args.text, { steer: true });
        return { accepted: result.accepted === true };
      }
      return null;
    },
    async interruptOutside(args, row) {
      if (host.zcode.hasManagedSession(row.nativeId)) {
        return host.zcode.interrupt(row.nativeId);
      }
      const route = host.discovery.routeFor(args.ref);
      if (!route || route.via !== "host" || row.sendVia !== "host") return null;
      if (!host.zcodeHost) throw host.fail("read_only");
      if (!harnessFor(row.engine)?.caps(row).interrupt) throw host.fail("invalid", "此入口不支持停止");
      const result = await host.zcodeHost.interrupt(route.sessionId);
      return { outcome: String(result.outcome ?? "unknown").slice(0, 100) };
    },
    models() {
      return host.zcode.models();
    },
    skills(_session, cwd) {
      return host.zcode.skills(cwd);
    },
    hasRequest(id) {
      return host.zcode.hasRequest(id);
    },
    answerRequest(args) {
      return host.zcode.answer(args);
    },
    archive(_ref, row, archived) {
      return host.zcode.archiveSession(row.nativeId, archived);
    },
    deleteSession(_ref, row) {
      return host.zcode.deleteSession(row.nativeId);
    },
    relink() {
      host.zcode.relink();
    },
    close() {
      return host.zcode.close();
    },
  };

  const agyDriver: HarnessDriver = {
    id: "agy",
    async probe() {
      if (!host.shouldProbeAgy) return { available: false, version: null };
      const probed = await host.probeCli("agy");
      if (!probed.available) return probed;
      const outdated = !supportsAgyAcp(probed.version);
      host.setAgyNeedsUpdate(outdated);
      if (outdated) return { available: false, version: probed.version };
      host.agy.enable();
      return probed;
    },
    watchSource(_ref, row): HarnessWatchSource {
      return { chat: { threadId: row.nativeId }, db: host.agy };
    },
    read(_ref, row, before, limit) {
      return host.agy.page(row.nativeId, before ? { before } : {}, limit);
    },
    async start(args, cwd, budget) {
      const id = await host.agy.start(cwd, launchOptionsOf(args, "ask"));
      const ref = cliRef("agy", id);
      await host.awaitRow(ref, budget - 1000);
      return { ref, cwd };
    },
    async continueSession(args, row) {
      const terminal = host.addressFor(args.ref);
      if (terminal) return { ref: args.ref, terminal };
      await validateCwd(row.cwd, { platform: host.platform, env: host.env });
      await host.agy.resume(row, launchOptionsOf(args));
      return { ref: args.ref };
    },
    async sendOutside(args, row) {
      if (row.sendVia !== "acp") throw host.fail(row.writerUnknown || row.liveIn ? "open_elsewhere" : "stopped");
      return host.agy.send(row.nativeId, args.text);
    },
    async steer(args, row, managedAddress) {
      if (managedAddress || row.sendVia !== "acp") return null;
      const result = await host.agy.send(row.nativeId, args.text, true);
      return { accepted: true, started: result.started };
    },
    async interruptOutside(_args, row) {
      if (row.sendVia !== "acp") return null;
      return host.agy.interrupt(row.nativeId);
    },
    models() {
      return host.agy.models();
    },
    extraEnv() {
      return host.agy.proxyEnvironment();
    },
    hasRequest(id) {
      return host.agy.hasRequest(id);
    },
    answerRequest(args) {
      return host.agy.answer(args);
    },
    archive(_ref, row, archived) {
      return host.agy.archiveSession(row.nativeId, row.configDir, archived);
    },
    deleteSession(_ref, row) {
      return host.agy.deleteSession(row.nativeId, row.configDir);
    },
    relink() {
      host.agy.relink();
    },
    close() {
      return host.agy.close();
    },
  };

  return new Map<CliEngine, HarnessDriver>([
    ["claude", claudeDriver],
    ["codex", codexDriver],
    ["zcode", zcodeDriver],
    ["agy", agyDriver],
  ]);
}
