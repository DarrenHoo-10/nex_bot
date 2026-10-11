import { expect, it } from "vitest";
import { startFakeModel } from "./fake-model.ts";

it("reselects a fetch-blocked fixture port before model calls without consuming or retrying a model script", async () => {
  const fetchOriginal = globalThis.fetch;
  let probes = 0;
  const probeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/__nex_fixture_health") && probes++ === 0) throw new TypeError("fetch failed", { cause: new Error("bad port") });
    return fetchOriginal(input, init);
  };
  const fixture = await startFakeModel(probeFetch);
  try {
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(fixture.requests).toEqual([]);
    fixture.scripts.push({ kind: "openai-text", text: "synthetic fixture reply" });
    const response = await fetchOriginal(fixture.origin + "/v1/chat/completions", { method: "POST", body: "{}" });
    expect(await response.text()).toContain("synthetic fixture reply");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.scripts).toEqual([]);
  } finally { await fixture.close(); }
});
