import { describe, expect, it } from "vitest";
import { httpErrorText, readJson, responseErrorText, userErrorText } from "../lib/http-errors";

describe("errors people see", () => {
  it("never shows a parser's or browser's wording", () => {
    expect(userErrorText(new SyntaxError("Failed to execute 'json' on 'Response': Unexpected token '<', \"<html>\n<h\"... is not valid JSON"), "读取失败")).toBe("读取失败");
    expect(userErrorText(new TypeError("Failed to fetch"))).toBe("网络连接失败，请检查网络后重试");
    expect(userErrorText(new Error("请先停止并核对该 Agent 的未结束工作"))).toBe("请先停止并核对该 Agent 的未结束工作");
  });

  it("reads a proxy's HTML page as no JSON and words the status", async () => {
    expect(await readJson(new Response("<html><h1>502 Bad Gateway</h1></html>", { status: 502 }))).toBeNull();
    expect(responseErrorText(502, null)).toBe("服务暂时不可用，可能正在更新，请稍后重试");
    expect(responseErrorText(400, { error: "名称不能为空" })).toBe("名称不能为空");
    expect(httpErrorText(504)).toBe("服务响应超时，请稍后重试");
  });
});
