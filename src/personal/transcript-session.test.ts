import { describe, expect, it } from "vitest";
import { topicTimeline } from "./FinanceTopics";
import {
  SCROLL_TO_BOTTOM_THRESHOLD,
  findUnreadJumpTarget,
  imageFilesFromClipboard,
  optimisticOutgoing,
  shouldShowScrollToBottom,
  withPendingOptimistic,
  withoutCommittedStreaming,
} from "./transcript-session";

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

  it("drops a live reply once the same assistant text is committed", () => {
    const messages = [{ id: "a", role: "assistant", kind: "message", content: "完整回复", task_id: "t1", seq: 2 }];
    expect(withoutCommittedStreaming(messages, [
      { taskId: "t1", text: "完整回复" },
      { taskId: "t1", text: "完整回复，还有" },
      { taskId: "t2", text: "另一段" },
      { taskId: "t3", text: "" },
    ])).toEqual([{ taskId: "t1", text: "完整回复，还有" }, { taskId: "t2", text: "另一段" }]);
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
    const untypedPng = new File([Uint8Array.from([137, 80, 78, 71])], "diagram.png", { type: "" });
    const untypedJpg = new File([Uint8Array.from([255, 216, 255])], "photo.jpg", { type: "" });
    const inferred = imageFilesFromClipboard({
      items: [{ kind: "file", type: "", getAsFile: () => untypedPng }],
      files: [untypedPng, untypedJpg],
    });
    expect(inferred.map((file) => [file.name, file.type, file.size])).toEqual([["diagram.png", "image/png", 4]]);
    const fromFiles = imageFilesFromClipboard({ items: [], files: [untypedJpg] });
    expect(fromFiles.map((file) => [file.name, file.type, file.size])).toEqual([["photo.jpg", "image/jpeg", 3]]);
  });

  it("finds the earliest unread main message or unread topic card in timeline order", () => {
    const timeline = topicTimeline(
      [
        { id: "m1", seq: 1, role: "assistant", kind: "message", content: "已读消息", created_at: 10 },
        { id: "m2", seq: 2, role: "user", kind: "message", content: "我的消息", created_at: 20 },
        { id: "m3", seq: 3, role: "assistant", kind: "message", content: "导入记录", source_key: "stock-history:1", created_at: 25 },
        { id: "m4", seq: 4, role: "assistant", kind: "message", content: "最早未读回复", created_at: 40 },
        { id: "m5", seq: 5, role: "assistant", kind: "message", content: "较新未读回复", created_at: 60 },
      ],
      [
        {
          conversationId: "topic-read",
          title: "已读话题",
          audience: "private",
          sourceContext: {},
          last_activity_at: 15,
          message_count: 2,
          unread_count: 0,
          activeTask: null,
        },
        {
          conversationId: "topic-unread-early",
          title: "较早未读话题",
          audience: "public",
          sourceContext: { channel: "feishu", chatName: "反馈群" },
          last_activity_at: 30,
          message_count: 3,
          messages: [{ id: "tm1", role: "assistant", content: "查到了。**NexBot macOS** 已修复" }],
          unread_count: 2,
          activeTask: null,
        },
      ],
    );

    // Topic preview strips Markdown syntax rather than leaking raw ** markers.
    const topicRow = timeline.find((row) => row.id === "topic-unread-early");
    expect(topicRow?.preview).toBe("查到了。NexBot macOS 已修复");

    // No unread -> stays at bottom.
    expect(findUnreadJumpTarget({ messages: timeline, readSeq: 1, mainUnreadCount: 0, topicUnreadCount: 0 })).toBeNull();

    // Only sub-conversation unread -> jumps to the corresponding topic card.
    expect(findUnreadJumpTarget({ messages: timeline, readSeq: 5, mainUnreadCount: 0, topicUnreadCount: 2 })).toEqual({
      kind: "topic",
      id: "topic-unread-early",
    });

    // Both main and topic unread -> picks whichever appears earliest in the timeline (topic at t=30 before m4 at t=40).
    expect(findUnreadJumpTarget({ messages: timeline, readSeq: 1, mainUnreadCount: 2, topicUnreadCount: 2 })).toEqual({
      kind: "topic",
      id: "topic-unread-early",
    });

    // Only main unread -> skips user & stock-history rows and lands on earliest unread assistant reply (m4).
    expect(findUnreadJumpTarget({ messages: timeline, readSeq: 1, mainUnreadCount: 2, topicUnreadCount: 0 })).toEqual({
      kind: "message",
      id: "m4",
    });
  });

  it("shows the scroll-to-bottom control based on scroll distance rather than message count", () => {
    expect(shouldShowScrollToBottom({ following: true, distanceFromBottom: 600, hasMessages: true })).toBe(false);
    expect(shouldShowScrollToBottom({ following: false, distanceFromBottom: SCROLL_TO_BOTTOM_THRESHOLD - 1, hasMessages: true })).toBe(false);
    expect(shouldShowScrollToBottom({ following: false, distanceFromBottom: SCROLL_TO_BOTTOM_THRESHOLD, hasMessages: true })).toBe(true);
    expect(shouldShowScrollToBottom({ following: false, distanceFromBottom: 600, hasMessages: false })).toBe(false);
    expect(shouldShowScrollToBottom({ following: true, distanceFromBottom: 0, hasMessages: true, focused: true })).toBe(true);
  });
});
