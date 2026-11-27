import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { htmlToReadableText, validateWebFetchArgs, webFetch } from "./web-fetch.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it("extracts readable text from HTML while dropping scripts and styles", () => {
  const html = `<!doctype html><html><head><title>Releases</title><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>NexBot v0.2.52</h1><p>Fix &amp; improve updater.</p><div>Restart dialog added.</div></body></html>`;
  expect(htmlToReadableText(html)).toBe("Releases\nNexBot v0.2.52\nFix & improve updater.\nRestart dialog added.");
});

it("validates URL scheme, HTTP method, headers and maxChars", () => {
  expect(() => validateWebFetchArgs({ url: "file:///etc/passwd" })).toThrow(/http/);
  expect(() => validateWebFetchArgs({ url: "https://example.com", method: "TRACE" })).toThrow(/HTTP/);
  expect(() => validateWebFetchArgs({ url: "https://example.com", maxChars: 10 })).toThrow(/maxChars/);
  expect(validateWebFetchArgs({ url: "https://example.com/releases" })).toMatchObject({
    url: "https://example.com/releases", method: "GET", maxChars: 30_000,
  });
});

it("fetches JSON and HTML over HTTP, follows redirects and truncates to maxChars", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/release" }); res.end(); return; }
    if (req.url === "/release") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h2>v0.2.52</h2><p>macOS 重启更新弹窗已修复</p></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag: "v0.2.52", notes: "x".repeat(500) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const page = await webFetch({ url: `${base}/redirect` });
  expect(page).toMatchObject({ url: `${base}/release`, status: 200, ok: true, truncated: false });
  expect(page.text).toContain("v0.2.52");
  expect(page.text).toContain("macOS 重启更新弹窗已修复");

  const api = await webFetch({ url: `${base}/api`, maxChars: 120 });
  expect(api).toMatchObject({ status: 200, ok: true, truncated: true });
  expect(api.text).toHaveLength(120);
});
