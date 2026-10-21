import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientUpdateSource, manifestKey, newerVersion, OssReleaseMirror, parseManifest } from "./client-updates.ts";
import { createPersonalApp } from "./index.ts";

const sha = "a".repeat(64);
const manifest = {
  version: 1, tag: "nexbot-v0.9.9-preview.1", publishedAt: "2026-10-22T02:00:00Z", notes: "修复若干问题",
  platforms: {
    windows: { version: "0.9.9", file: "NexBot-0.9.9-x64-Client-Portable.exe", key: "nexbot/releases/nexbot-v0.9.9-preview.1/NexBot-0.9.9-x64-Client-Portable.exe", size: 1024, sha256: sha },
    android: { version: "0.2.9", file: "nexbot-0.2.9-debug.apk", key: "nexbot/releases/nexbot-v0.9.9-preview.1/nexbot-0.2.9-debug.apk", size: 2048, sha256: sha },
  },
};
const mirror = { manifest: async () => parseManifest(manifest), signedUrl: (key: string) => `https://mirror.test/${key}?signed` };

describe("client updates", () => {
  it("compares x.y.z versions numerically and never treats malformed versions as newer", () => {
    expect(newerVersion("0.9.10", "0.9.9")).toBe(true);
    expect(newerVersion("0.9.9", "0.9.9")).toBe(false);
    expect(newerVersion("0.9.8", "0.9.9")).toBe(false);
    expect(newerVersion("1.0.0-beta", "0.9.9")).toBe(false);
    expect(newerVersion("0.9.9", "unknown")).toBe(true);
  });

  it("drops manifest entries that could send a client elsewhere or fail verification", () => {
    const parsed = parseManifest({ ...manifest, platforms: {
      ...manifest.platforms,
      mac: { version: "0.2.4", file: "NexBot.dmg", key: "https://evil.test/NexBot.dmg", size: 1, sha256: sha },
      ios: { version: "0.2.4", file: "NexBot.ipa", key: "nexbot/releases/t/NexBot.ipa", size: 1, sha256: "not-a-digest" },
    } });
    expect(Object.keys(parsed!.platforms)).toEqual(["windows", "android"]);
    expect(parseManifest({ version: 2, tag: "x", platforms: {} })).toBeUndefined();
  });

  it("signs mirror URLs with OSS query authentication and refuses other keys", () => {
    const secret = "synthetic-secret";
    const mirrorUrl = new OssReleaseMirror({ endpoint: "oss-cn-hangzhou.aliyuncs.com", bucket: "fixture-bucket", accessKeyId: "synthetic-id", accessKeySecret: secret }, fetch, () => 1_000_000_000_000);
    const url = new URL(mirrorUrl.signedUrl(manifest.platforms.windows.key, 3600));
    expect(url.origin).toBe("https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com");
    expect(url.pathname).toBe("/" + manifest.platforms.windows.key);
    expect(url.searchParams.get("Expires")).toBe("1000003600");
    expect(url.searchParams.get("Signature")).toBe(createHmac("sha1", secret).update(`GET\n\n\n1000003600\n/fixture-bucket/${manifest.platforms.windows.key}`).digest("base64"));
    expect(() => mirrorUrl.signedUrl("nexbot/attachments/v1/secret.enc")).toThrow();
    expect(new URL(mirrorUrl.signedUrl(manifestKey)).pathname).toBe("/" + manifestKey);
  });

  it("offers a newer version with its digest and a signed URL, and nothing when current", async () => {
    const source = new ClientUpdateSource(mirror);
    expect(await source.check("windows", "0.9.8")).toMatchObject({ available: true, version: "0.9.9", sha256: sha, size: 1024, url: `https://mirror.test/${manifest.platforms.windows.key}?signed`, notes: "修复若干问题" });
    expect(await source.check("windows", "0.9.9")).toEqual({ platform: "windows", current: "0.9.9", available: false });
    expect(await source.check("mac", "0.2.3")).toEqual({ platform: "mac", current: "0.2.3", available: false });
    await expect(source.check("plan9", "1.0.0")).rejects.toThrow("不支持的平台");
    expect(await new ClientUpdateSource(undefined).check("windows", "0.9.8")).toMatchObject({ available: false });
  });

  it("keeps the last good manifest through an outage", async () => {
    let calls = 0, at = 0;
    const flaky = { manifest: async () => { if (++calls > 1) throw new Error("offline"); return parseManifest(manifest); }, signedUrl: mirror.signedUrl };
    const source = new ClientUpdateSource(flaky, () => at);
    expect((await source.check("android", "0.2.8")).available).toBe(true);
    at = 10 * 60_000;
    expect((await source.check("android", "0.2.8")).version).toBe("0.2.9");
  });
});

describe("client update routes", () => {
  const roots: string[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("answers update checks and prefers mirrored downloads without signing in", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nex-client-update-")); roots.push(root);
    const github = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    const app = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic-token", identity: false, releaseMirror: mirror, clientDownloads: { fetch: github as typeof fetch } }); apps.push(app);
    const update = await (await fetch(`${app.origin}/api/client/update?platform=android&version=0.2.8`)).json();
    expect(update).toMatchObject({ available: true, version: "0.2.9", url: `https://mirror.test/${manifest.platforms.android.key}?signed` });
    const downloads = await (await fetch(`${app.origin}/api/client/downloads`)).json() as { windows?: unknown };
    expect(downloads.windows).toMatchObject({ version: "0.9.9", url: `https://mirror.test/${manifest.platforms.windows.key}?signed` });
  });
});
