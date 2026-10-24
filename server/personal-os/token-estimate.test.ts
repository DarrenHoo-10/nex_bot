import { expect, it } from "vitest";
import { IMAGE_TOKENS, tokens } from "./token-estimate.ts";

it("counts each image as a fixed cost instead of its base64 length", () => {
  const data = "A".repeat(1_500_000);
  const text = tokens([{ type: "text", text: "能看到图片吗" }]);
  for (const part of [
    { type: "image", data, mimeType: "image/jpeg" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } },
  ]) {
    const estimate = tokens({ messages: [{ role: "user", content: [{ type: "text", text: "能看到图片吗" }, part] }] });
    expect(estimate).toBeGreaterThan(text + IMAGE_TOKENS);
    expect(estimate).toBeLessThan(text + IMAGE_TOKENS + 100);
  }
  expect(tokens("A".repeat(3000))).toBe(1000);
  expect(tokens("合成")).toBe(3);
});
