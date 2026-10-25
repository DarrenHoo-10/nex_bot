import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientUpdater, portableHandoff } from "./nex-client-update.mjs";

const payload = Buffer.from("synthetic portable installer");
const digest = createHash("sha256").update(payload).digest("hex");
const offer = (extra = {}) => ({ available: true, version: "0.9.9", file: "NexBot-0.9.9-x64-Client-Portable.exe", size: payload.length, sha256: digest, url: "https://mirror.test/installer", notes: "修复", ...extra });

function fixture(answer, body = payload) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-update-")), states = [], requests = [];
  const updater = new ClientUpdater({ version: "0.9.8", directory, changed: (state) => states.push(state.status), fetch: async (url) => {
    requests.push(String(url));
    if (String(url).includes("/api/client/update")) return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
    return new Response(body);
  } });
  return { directory, updater, states, requests, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("downloads a newer portable, verifies it and offers it only when ready", async () => {
  const f = fixture(offer());
  try {
    const state = await f.updater.check("https://core.test");
    assert.equal(state.status, "ready");
    assert.equal(state.version, "0.9.9");
    assert.ok(f.requests[0].includes("platform=windows") && f.requests[0].includes("version=0.9.8"));
    assert.deepEqual(readFileSync(path.join(f.directory, offer().file)), payload);
    assert.ok(f.states.includes("downloading"));
    // A second check reuses the verified file instead of downloading again.
    await f.updater.check("https://core.test");
    assert.equal(f.requests.filter((url) => url === "https://mirror.test/installer").length, 1);
  } finally { f.cleanup(); }
});

test("a tampered or truncated download is discarded and never offered", async () => {
  for (const body of [Buffer.from("tampered installer bytes!!!!"), payload.subarray(0, 5)]) {
    const f = fixture(offer(), body);
    try {
      const state = await f.updater.check("https://core.test");
      assert.equal(state.status, "error");
      assert.equal(existsSync(path.join(f.directory, offer().file)), false);
      assert.equal(existsSync(path.join(f.directory, offer().file + ".part")), false);
    } finally { f.cleanup(); }
  }
});

test("only a successful no-update answer reports current; malformed answers report errors", async () => {
  const none = fixture({ available: false });
  try { assert.equal((await none.updater.check("https://core.test")).status, "current"); assert.deepEqual(none.states, ["checking", "current"]); } finally { none.cleanup(); }
  const bad = fixture(offer({ file: "evil.exe" }));
  try { assert.equal((await bad.updater.check("https://core.test")).status, "error"); assert.equal(bad.requests.length, 1); } finally { bad.cleanup(); }
});

test("a failed check can be retried and concurrent checks never duplicate requests", async () => {
  const f = fixture({ available: false });
  try {
    f.updater.transport = async () => { throw new Error("offline"); };
    assert.equal((await f.updater.check("https://core.test")).status, "error");
    assert.equal(f.updater.state().error, "offline");
    let respond;
    let requests = 0;
    f.updater.transport = () => { requests++; return new Promise(resolve => { respond = resolve; }); };
    const first = f.updater.check("https://core.test");
    assert.equal(f.updater.state().status, "checking");
    assert.equal((await f.updater.check("https://core.test")).status, "checking");
    assert.equal(requests, 1);
    respond(new Response(JSON.stringify({ available: false })));
    assert.equal((await first).status, "current");
    assert.equal(f.updater.state().error, undefined);
  } finally { f.cleanup(); }
});

test("the handoff starts the new portable with the same profile and removes only an old NexBot portable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-handoff-"));
  try {
    mkdirSync(path.join(directory, "downloads"));
    const downloaded = path.join(directory, "downloads", "NexBot-0.9.9-x64-Client-Portable.exe");
    writeFileSync(downloaded, payload);
    const currentExe = path.join(directory, "NexBot-0.9.8-x64-Client-Portable.exe");
    const script = portableHandoff({ downloaded, currentExe, pids: [11, 12], args: ["--profile=D:\\it's\\client"] });
    assert.deepEqual(readFileSync(path.join(directory, "NexBot-0.9.9-x64-Client-Portable.exe")), payload);
    assert.match(script, /^Wait-Process -Id 11,12 /);
    assert.ok(script.includes("-ArgumentList '--profile=D:\\it''s\\client'"));
    assert.ok(script.includes(`Remove-Item -LiteralPath '${currentExe}'`));
    const renamed = portableHandoff({ downloaded, currentExe: path.join(directory, "my-nexbot.exe"), pids: [11], args: [] });
    assert.ok(!renamed.includes("Remove-Item"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
