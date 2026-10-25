import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientDownloadsSource, pickDownloads, releasesPage } from "./client-downloads.ts";
import { createPersonalApp } from "./index.ts";

const download = (tag: string, name: string) => `https://github.com/DarrenHoo-10/nex_bot/releases/download/${tag}/${name}`;
const asset = (tag: string, name: string, extra: Record<string, unknown> = {}) => ({ name, state: "uploaded", size: 1024, browser_download_url: download(tag, name), ...extra });
const release = (tag: string, assets: unknown[], extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: true, published_at: "2026-10-18T12:14:16Z", assets, ...extra });
const releases = [
  release("nexbot-v0.9.6-preview.1", [asset("nexbot-v0.9.6-preview.1", "NexBot-0.9.6-x64-Client-Portable.exe")], { draft: true }),
  release("nexbot-v0.9.5-preview.1", [asset("nexbot-v0.9.5-preview.1", "nexbot-0.2.5-debug-unsigned.apk"), asset("nexbot-v0.9.5-preview.1", "NexBot-0.9.5-x64-Client-Portable.exe", { state: "starter" })]),
  release("nexbot-v0.9.4-preview.1", [asset("nexbot-v0.9.4-preview.1", "NexBot-0.9.4-x64-Client-Portable.exe"), asset("nexbot-v0.9.4-preview.1", "SHA256SUMS.txt")]),
  release("nexbot-v0.9.3-preview.1", [asset("nexbot-v0.9.3-preview.1", "nexbot-0.2.3-debug.apk"), asset("nexbot-v0.9.3-preview.1", "NexBot-0.9.3-x64-Client-Portable.exe")]),
];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("client downloads", () => {
  it("offers the newest installable asset per platform", () => {
    expect(pickDownloads(releases)).toEqual({
      releasesPage,
      windows: { name: "NexBot-0.9.4-x64-Client-Portable.exe", url: download("nexbot-v0.9.4-preview.1", "NexBot-0.9.4-x64-Client-Portable.exe"), size: 1024, version: "0.9.4", tag: "nexbot-v0.9.4-preview.1", publishedAt: "2026-10-18T12:14:16Z" },
      android: { name: "nexbot-0.2.3-debug.apk", url: download("nexbot-v0.9.3-preview.1", "nexbot-0.2.3-debug.apk"), size: 1024, version: "0.2.3", tag: "nexbot-v0.9.3-preview.1", publishedAt: "2026-10-18T12:14:16Z" },
    });
  });
  it("never links an asset hosted outside the repository's releases", () => {
    const foreign = release("nexbot-v0.9.9", [asset("x", "NexBot-0.9.9-x64-Client-Portable.exe", { browser_download_url: "https://example.test/NexBot-0.9.9-x64-Client-Portable.exe" })]);
    expect(pickDownloads([foreign])).toEqual({ releasesPage });
    expect(pickDownloads({ message: "API rate limit exceeded" })).toEqual({ releasesPage });
  });
  it("shares one lookup, caches it, and keeps the last good answer through GitHub failures", async () => {
    let now = 0, calls = 0, fail = false;
    const source = new ClientDownloadsSource({ now: () => now, ttlMs: 1_000, failureTtlMs: 100, fetch: (async () => { calls++; return fail ? reply({ message: "rate limited" }, 403) : reply(releases); }) as typeof fetch });
    const [first, second] = await Promise.all([source.current(), source.current()]);
    expect(calls).toBe(1); expect(second).toBe(first); expect(first.windows?.version).toBe("0.9.4");
    now = 999; await source.current(); expect(calls).toBe(1);
    now = 1_000; fail = true;
    expect((await source.current()).windows?.version).toBe("0.9.4"); expect(calls).toBe(2);
    now = 1_050; await source.current(); expect(calls).toBe(2);
    expect((await new ClientDownloadsSource({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch }).current())).toEqual({ releasesPage });
  });
});

describe("public downloads endpoint", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  it("answers signed-out browsers without a session", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nex-downloads-")); roots.push(root);
    const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: "synthetic-bootstrap", memoryRuntime: false, identity: false, clientDownloads: { fetch: (async () => reply(releases)) as typeof fetch } });
    try {
      const response = await fetch(app.origin + "/api/client/downloads");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ releasesPage, windows: { version: "0.9.4" }, android: { version: "0.2.3" } });
      expect((await fetch(app.origin + "/api/state")).status).toBe(401);
    } finally { await app.close(); }
  });
});
