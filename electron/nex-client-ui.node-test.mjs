import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installLocalUi } from "./nex-client-ui.mjs";

test("local UI overrides only approved static GETs on the authenticated Core origin", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-ui-unit-"));
  try {
    mkdirSync(path.join(directory, "assets"));
    writeFileSync(path.join(directory, "index.html"), "<head></head><body>local</body>");
    writeFileSync(path.join(directory, "assets/app.js"), "localScript");
    const preview = '<head></head><body>preview</body>';
    writeFileSync(path.join(directory, "html-preview.html"), preview);
    writeFileSync(path.join(directory, "private.json"), "must not serve");
    const handlers = new Map(), forwarded = [];
    let origin;
    const session = { protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) }, fetch: async (request, options) => { forwarded.push({ request, options }); return new Response("remote"); } };
    assert.equal(installLocalUi(session, directory, () => origin), true);
    const get = (url, init) => handlers.get(new URL(url).protocol.slice(0, -1))(new Request(url, init));
    assert.equal(await (await get("https://core.example/")).text(), "remote");
    origin = "https://core.example";
    assert.match(await (await get(origin + "/")).text(), /nexbot-ui-source/);
    assert.equal(await (await get(origin + "/assets/app.js")).text(), "localScript");
    const previewResponse = await get(origin + "/html-preview.html");
    assert.equal(await previewResponse.text(), preview);
    assert.equal(previewResponse.headers.get('Content-Security-Policy'), "sandbox allow-scripts; frame-ancestors 'self'");
    assert.equal(await (await get(origin + '/html-preview.html', { method: 'POST' })).text(), 'remote');
    for (const url of [origin + "/api/state", origin + "/api/events", origin + "/private.json", origin + "/assets/unknown.js", "https://other.example/", "http://core.example/"]) assert.equal(await (await get(url)).text(), "remote");
    const post = await get(origin + "/api/bots", { method: "POST", body: "synthetic-body", headers: { "Content-Type": "text/plain" } });
    assert.equal(await post.text(), "remote");
    assert.equal(await forwarded.at(-1).request.text(), "synthetic-body");
    assert.ok(forwarded.every(item => item.options.bypassCustomProtocolHandlers === true));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("normal thin clients without local UI do not intercept protocols", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-ui-empty-"));
  try { assert.equal(installLocalUi({ protocol: { handle: () => assert.fail("unexpected override") } }, directory, () => "https://core.example"), false); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
