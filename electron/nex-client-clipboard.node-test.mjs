import { test } from "node:test";
import assert from "node:assert/strict";
import { clipboardImageForPaste, installClipboardImagePaste } from "./nex-client-clipboard.mjs";

const origin = "https://core.example";
const page = origin + "/";
const png = Buffer.from([137, 80, 78, 71]);

function clipboard({ text = "", image = png, empty = false } = {}) {
  return {
    readText: () => text,
    readImage: () => ({ isEmpty: () => empty || !image, toPNG: () => image }),
  };
}

test("image-only Ctrl or Cmd+V on the Core origin is delivered to the page", () => {
  for (const input of [
    { type: "keyDown", key: "v", control: true },
    { type: "keyDown", key: "V", meta: true },
  ]) {
    const sent = [];
    const contents = {
      getURL: () => page,
      send: (channel, payload) => sent.push({ channel, payload }),
      on(event, handler) { this.handler = handler; this.event = event; },
      removeListener() {},
    };
    installClipboardImagePaste(contents, clipboard(), () => origin);
    let prevented = false;
    contents.handler({ preventDefault() { prevented = true; } }, input);
    assert.equal(contents.event, "before-input-event");
    assert.equal(prevented, true);
    assert.deepEqual(sent, [{ channel: "nex:clipboard-image", payload: { name: "截图.png", type: "image/png", bytes: png } }]);
  }
});

test("text, modifiers, the wrong page, and unusable images stay on the native paste path", () => {
  const cases = [
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard({ text: "hello" }), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true, shift: true }, clip: clipboard(), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true, alt: true }, clip: clipboard(), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true, isAutoRepeat: true }, clip: clipboard(), url: page, core: origin },
    { input: { type: "keyUp", key: "v", control: true }, clip: clipboard(), url: page, core: origin },
    { input: { type: "keyDown", key: "c", control: true }, clip: clipboard(), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard(), url: "file:///connection.html", core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard(), url: "https://core.example.attacker/", core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard({ empty: true }), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard({ image: Buffer.alloc(0) }), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard({ image: Buffer.alloc(5 * 1024 * 1024 + 1) }), url: page, core: origin },
    { input: { type: "keyDown", key: "v", control: true }, clip: clipboard({ text: "  \n" }), url: page, core: origin },
  ];
  // Whitespace-only text is still an image paste (the last case expects an image).
  const whitespace = cases.pop();
  for (const item of cases) {
    assert.equal(clipboardImageForPaste(item.input, item.clip, item.url, item.core), null, JSON.stringify(item.input) + " " + item.url);
  }
  assert.equal(clipboardImageForPaste(whitespace.input, whitespace.clip, whitespace.url, whitespace.core)?.name, "截图.png");
});

test("a clipboard read failure does not swallow the key", () => {
  const clip = { readText() { throw new Error("unavailable"); }, readImage() { throw new Error("unavailable"); } };
  assert.equal(clipboardImageForPaste({ type: "keyDown", key: "v", control: true }, clip, page, origin), null);
});
