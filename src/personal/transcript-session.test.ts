import { describe, expect, it } from "vitest";
import { imageFilesFromClipboard, optimisticOutgoing, withPendingOptimistic } from "./transcript-session";

describe("transcript session", () => {
  it("keeps an optimistic send until the matching server row arrives", () => {
    const pending = optimisticOutgoing("client-1", "刚发出去", 10);
    const earlier = { id: "m1", role: "user", kind: "message", content: "更早的问题", created_at: 1, seq: 1, source_key: "older" };
    expect(withPendingOptimistic([earlier], [earlier, pending])).toEqual([earlier, pending]);
    const delivered = { id: "m2", role: "user", kind: "message", content: "刚发出去\n\n[附件](x)", created_at: 11, seq: 2, source_key: "agent-input:agent:client-1" };
    expect(withPendingOptimistic([earlier, delivered], [earlier, pending])).toEqual([earlier, delivered]);
  });

  it("keeps a second send of the same text", () => {
    const first = { id: "m1", role: "user", kind: "message", content: "好", created_at: 1, seq: 1, source_key: "agent-input:agent:client-1" };
    const again = optimisticOutgoing("client-2", "好", 2);
    expect(withPendingOptimistic([first], [first, again])).toEqual([first, again]);
  });

  it("names a screenshot whose file metadata is empty and ignores text", () => {
    const blank = new File([Uint8Array.from([1, 2, 3])], "", { type: "" });
    const images = imageFilesFromClipboard({
      items: [{ kind: "file", type: "image/png", getAsFile: () => blank }],
      files: [],
    });
    expect(images.map((file) => [file.name, file.type, file.size])).toEqual([["截图.png", "image/png", 3]]);
    const text = imageFilesFromClipboard({
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      files: [new File(["hello"], "note.txt", { type: "text/plain" })],
    });
    expect(text).toEqual([]);
  });
});
