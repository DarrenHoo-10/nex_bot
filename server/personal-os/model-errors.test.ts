import { describe, expect, it } from "vitest";
import { modelConnectionError } from "./model-errors.ts";

describe("model transport errors", () => {
  it("reports transport causes without copying secrets or arbitrary exception text", () => {
    for (const [code, detail] of [["ENOTFOUND", "域名解析"], ["CERT_HAS_EXPIRED", "TLS"], ["ECONNREFUSED", "拒绝连接"], ["UND_ERR_SOCKET", "中断"], ["UND_ERR_CONNECT_TIMEOUT", "超时"]]) {
      const error = new Error("synthetic-private-payload", { cause: Object.assign(new Error("synthetic-private-key"), { code }) });
      const message = modelConnectionError(error, new URL("https://user:secret@model.example/v1/chat/completions?key=synthetic-private-key#private")).message;
      expect(message).toContain(detail); expect(message).toContain(code);
      expect(message).toContain("https://model.example/v1/chat/completions");
      expect(message).not.toMatch(/secret|private|user:/);
    }
  });
  it("recognizes blocked fetch ports and timeouts with a bounded fallback", () => {
    const url = new URL("http://127.0.0.1:6000/v1/chat/completions");
    expect(modelConnectionError(new Error("fetch failed", { cause: new Error("bad port") }), url).message).toContain("FETCH_BAD_PORT");
    expect(modelConnectionError(new DOMException("private", "TimeoutError"), url).message).toContain("超时");
    expect(modelConnectionError("private", url).message).not.toContain("private");
  });
});
