import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogSettings, fetchModelCatalog } from "./model-catalog.mjs";

const saved = { provider: "openai", endpoint: "https://models.example/v1", apiKey: "synthetic-secret" };
test("saved key is reused only for the same normalized endpoint and protocol", () => {
  assert.equal(catalogSettings({ ...saved, endpoint: saved.endpoint + "/", apiKey: "" }, saved).apiKey, saved.apiKey);
  for (const change of [{ endpoint: "https://other.example/v1" }, { provider: "anthropic" }]) assert.throws(() => catalogSettings({ ...saved, ...change, apiKey: "" }, saved), /API Key/);
  for (const endpoint of ["http://remote.example", "https://user:pass@example.com", "https://example.com/?secret=a", "file:///tmp/key"]) assert.throws(() => catalogSettings({ ...saved, endpoint }));
});
test("model catalogs use correct credentials, disable redirects, deduplicate and report partial results", async () => {
  let calls = 0;
  const result = await fetchModelCatalog(saved, async (url, init) => {
    calls++; assert.equal(url, saved.endpoint + "/models"); assert.equal(init.headers.Authorization, "Bearer synthetic-secret"); assert.equal(init.redirect, "error");
    return Response.json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, {}, { id: 42 }], has_more: true });
  });
  assert.deepEqual(result, { models: ["a", "b"], hasMore: true }); assert.equal(calls, 1);
  for (const endpoint of ["https://models.example", "https://models.example/v1"]) await fetchModelCatalog({ ...saved, provider: "anthropic", endpoint }, async (url, init) => {
    assert.equal(url, "https://models.example/v1/models"); assert.equal(init.headers["x-api-key"], saved.apiKey); assert.equal(init.headers.Authorization, undefined); return Response.json({ data: [] });
  });
});
test("catalog failures do not expose upstream bodies or credentials", async () => {
  for (const status of [401, 403, 404, 500]) await assert.rejects(fetchModelCatalog(saved, async () => new Response("echo synthetic-secret", { status })), error => !error.message.includes("synthetic-secret"));
  await assert.rejects(fetchModelCatalog(saved, async () => new Response("not json")), /格式无效/);
  await assert.rejects(fetchModelCatalog(saved, async () => new Response("x".repeat(2 * 1024 * 1024 + 1))), /过大/);
});
