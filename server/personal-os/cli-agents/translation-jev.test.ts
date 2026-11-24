import { afterEach, expect, it, vi } from "vitest";
import { jevAvailable, tryJevTranslationFilter } from "./translation-jev.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("uses rules at 5 seconds and pauses requests globally for one hour after the eleventh failure", async () => {
  vi.stubEnv("NEX_TRANSLATION_JEV_PROXY", "");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    options?.signal?.throwIfAborted();
    return new Response(null, { status: 503 });
  });
  vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(milliseconds => {
    expect(milliseconds).toBe(5_000);
    return AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
  });
  const run = (key: string) => tryJevTranslationFilter(["The tests passed."], key, new AbortController().signal);
  expect(await run("synthetic-key-a")).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[translation] using rules:", "Jev translation filter exceeded 5 seconds");
  for (let count = 0; count < 9; count++) expect(await run("synthetic-key-b")).toBeUndefined();
  expect(jevAvailable()).toBe(true);

  const goodAnswer = () => Promise.resolve(Response.json({ answers: { p1: { type: "noul", noul: 0.99 } } }));
  request.mockImplementationOnce(goodAnswer);
  expect(await run("synthetic-key-a")).toEqual(new Set(["The tests passed."]));
  expect(await run("synthetic-key-b")).toBeUndefined();
  expect(jevAvailable()).toBe(false);
  expect(await run("synthetic-key-a")).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(12);

  now.mockReturnValue(1_000 + 60 * 60_000 - 1);
  expect(jevAvailable()).toBe(false);
  now.mockReturnValue(1_000 + 60 * 60_000);
  request.mockImplementationOnce(goodAnswer);
  expect(await run("synthetic-key-b")).toEqual(new Set(["The tests passed."]));
  expect(jevAvailable()).toBe(true);
  expect(request).toHaveBeenCalledTimes(13);
});
