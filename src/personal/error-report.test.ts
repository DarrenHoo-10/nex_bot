import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorBoundary, ErrorPanel } from "./ErrorBoundary";
import { describeError } from "./error-report";

beforeEach(() => {
  vi.stubGlobal("location", { pathname: "/index.html", hash: "#token=secret" });
  vi.stubGlobal("navigator", { userAgent: "TestWebView/1" });
});
afterEach(() => vi.unstubAllGlobals());

it("reports the message, the top of the stack, the component path and the environment", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'map')");
  error.stack = ["TypeError: Cannot read properties of undefined (reading 'map')", ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (main.js:1:${i})`)].join("\n");
  const text = describeError(error, "\n    at Messages\n    at AgentDesktop");
  expect(text).toContain("TypeError: Cannot read properties of undefined (reading 'map')");
  expect(text).toContain("at frame0"); expect(text).toContain("at frame7"); expect(text).not.toContain("at frame8");
  expect(text).toContain("组件：\nat Messages\nat AgentDesktop");
  expect(text).toContain("/index.html"); expect(text).toContain("TestWebView/1");
  // A login token in the URL fragment must never end up in a report people paste around.
  expect(text).not.toContain("secret");
});
it("describes things that are not Error objects", () => {
  expect(describeError("boom")).toContain("boom");
  expect(describeError({ code: 7 })).toContain('{"code":7}');
  expect(describeError(undefined)).toContain("undefined");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => describeError(cyclic)).not.toThrow();
  const long = describeError(new Error("x".repeat(5000)));
  // The first 600 characters include the "Error: " prefix.
  expect(long).toContain("x".repeat(590)); expect(long).not.toContain("x".repeat(601));
});
it("renders the report with retry, reload and copy actions, escaping its content", () => {
  const html = renderToStaticMarkup(createElement(ErrorPanel, { details: "<img src=x onerror=alert(1)>", onRetry: () => undefined }));
  expect(html).toContain('role="alert"');
  for (const label of ["重试", "重新加载", "复制错误"]) expect(html).toContain(label);
  expect(html).toContain("&lt;img src=x"); expect(html).not.toContain("<img");
});
it("turns a thrown value into the failed state, including falsy throws", () => {
  expect(ErrorBoundary.getDerivedStateFromError(new Error("bad"))).toMatchObject({ failed: true });
  expect(ErrorBoundary.getDerivedStateFromError(null)).toEqual({ failed: true, error: null });
});
it("renders its children while nothing has failed", () => {
  expect(renderToStaticMarkup(createElement(ErrorBoundary, null, createElement("p", null, "正常内容")))).toBe("<p>正常内容</p>");
});
