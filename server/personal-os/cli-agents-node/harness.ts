// Harness adapters (workbench plan section 2). Behind the bridge and the
// discovery sits a small compile-time registry: one adapter per harness id
// that says what its sessions can do and how a write reaches them, so a
// fourth harness is only "register an id, implement the adapter, add the
// icon and the contract cases" and the queue, the components and the tree
// stay untouched. The bridge consults the registry for write routing and
// capability answers; Core stays engine-agnostic.
import type { CliEngine, CliSendVia, CliSessionWire } from "../../../shared/cli-agents.ts";

/** What one harness says about one of its sessions. The device reports this
 * per session; the UI renders from it and the workbench queue relies on the
 * steer/interrupt answers. */
export interface HarnessSessionCaps {
  /** how a message reaches the session right now; undefined: read-only */
  sendVia?: CliSendVia;
  /** guidance into the running turn is possible */
  steer: boolean;
  /** the current turn can be stopped */
  interrupt: boolean;
  /** the session runs in a nex_bot terminal this page can attach to */
  terminal: boolean;
  /** the device can create a real fork with inherited context */
  fork: "native" | "copy" | "none";
}

export interface HarnessAdapter {
  readonly id: CliEngine;
  readonly label: string;
  caps(session: CliSessionWire): HarnessSessionCaps;
}

/** A session inside one of nex_bot's own herdr-core terminals: everything
 * works, because the terminal is ours. */
const terminalCaps = (session: CliSessionWire): HarnessSessionCaps =>
  session.terminal ? { sendVia: "terminal", steer: true, interrupt: true, terminal: true, fork: "copy" } : none();

const none = (): HarnessSessionCaps => ({ steer: false, interrupt: false, terminal: false, fork: "none" });

const claude: HarnessAdapter = {
  id: "claude",
  label: "Claude Code",
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // Claude’s inbox takes “send now” for steering and stopping.
    if (session.sendVia === "inbox") return { sendVia: "inbox", steer: true, interrupt: true, terminal: false, fork: "copy" };
    return none();
  },
};

const codex: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // a thread loaded in a shared app-server daemon takes messages and steers
    // the running turn; there is no interrupt path through the daemon
    if (session.sendVia === "daemon") return { sendVia: "daemon", steer: true, interrupt: false, terminal: false, fork: "copy" };
    if (session.sendVia === "inbox") return { sendVia: "inbox", steer: false, interrupt: false, terminal: false, fork: "copy" };
    return none();
  },
};

const zcode: HarnessAdapter = {
  id: "zcode",
  label: "ZCode",
  caps(session) {
    if (session.terminal) return terminalCaps(session);
    // a session the device's host channel has attached takes messages, guidance
    // and interrupts; without an attached host the sessions stay read-only
    if (session.sendVia === "host") return { sendVia: "host", steer: true, interrupt: true, terminal: false, fork: "none" };
    return none();
  },
};

const ADAPTERS: readonly HarnessAdapter[] = [claude, codex, zcode];

export function harnessFor(engine: CliEngine): HarnessAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === engine) ?? null;
}

export function allHarnesses(): readonly HarnessAdapter[] {
  return ADAPTERS;
}
