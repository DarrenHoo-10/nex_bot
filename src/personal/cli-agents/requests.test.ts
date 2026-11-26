import { describe, expect, it } from "vitest";
import { permissionRequest, questionRequest } from "./fixtures";
import { newRequests, requestBody } from "./notifications";
import {
  answersComplete, answersFor, cardState, CLOSED_KEEP, CLOSED_SHOW_MS, dropOpen, EMPTY_STORE, EXPIRY_GRACE_MS, markAnswered, mergePending,
  nextExpiry, OTHER_CHOICE, pendingCounts, pendingViews, resolveRequest, setPending, shownCards, toggleChoice,
} from "./requests";
import { askedSession, waitingCount } from "./session-model";
import { session } from "./fixtures";

const KEY = "dev1:claude:s1";
const NOW = 100_000;
const req = (id: string, expiresAt = NOW + 60_000) => permissionRequest({ id, expiresAt });

describe("pending lists", () => {
  it("replaces the open cards of one session and leaves the others", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a"), req("b")]);
    store = setPending(store, "dev1:claude:s2", [permissionRequest({ id: "c", key: "dev1:claude:s2" })]);
    store = setPending(store, KEY, [req("b")]);
    expect(store.get(KEY)?.map((record) => record.view.id)).toEqual(["b"]);
    expect(store.get("dev1:claude:s2")).toHaveLength(1);
    expect(setPending(store, KEY, []).has(KEY)).toBe(false);
  });

  it("ignores requests of another session in a list", () => {
    const store = setPending(EMPTY_STORE, KEY, [permissionRequest({ id: "x", key: "dev1:claude:other" })]);
    expect(store.size).toBe(0);
  });

  it("keeps a closed card closed when a late list still names it", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a")]);
    store = resolveRequest(store, KEY, "a", "terminal");
    store = setPending(store, KEY, [req("a"), req("b")]);
    expect(store.get(KEY)?.map((record) => [record.view.id, record.closed])).toEqual([["a", true], ["b", false]]);
  });

  it("merges an HTTP answer by adding only", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a")]);
    store = mergePending(store, [req("a"), req("b")]);
    expect(store.get(KEY)?.map((record) => record.view.id)).toEqual(["a", "b"]);
    // nothing in the answer does not remove what a push added
    expect(mergePending(store, []).get(KEY)).toHaveLength(2);
  });

  it("drops the open cards and keeps the closed ones when the list is sent again", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a"), req("b")]);
    store = resolveRequest(store, KEY, "a", "timeout");
    const next = dropOpen(store);
    expect(next.get(KEY)?.map((record) => record.view.id)).toEqual(["a"]);
  });

  it("keeps only the newest closed cards of a session", () => {
    let store = setPending(EMPTY_STORE, KEY, Array.from({ length: CLOSED_KEEP + 3 }, (_, index) => req(`r${index}`)));
    for (let index = 0; index < CLOSED_KEEP + 3; index++) store = resolveRequest(store, KEY, `r${index}`, "terminal");
    expect(store.get(KEY)).toHaveLength(CLOSED_KEEP);
    expect(store.get(KEY)?.[0].view.id).toBe("r3");
  });
});

describe("how a card reads", () => {
  it("is pending until its expiry plus the grace, then expired", () => {
    const store = setPending(EMPTY_STORE, KEY, [req("a", 1_000)]);
    const record = store.get(KEY)![0];
    expect(cardState(record, 1_000 + EXPIRY_GRACE_MS)).toBe("pending");
    expect(cardState(record, 1_000 + EXPIRY_GRACE_MS + 1)).toBe("expired");
  });

  it("says who closed it", () => {
    const state = (by: Parameters<typeof resolveRequest>[3]) => cardState(resolveRequest(setPending(EMPTY_STORE, KEY, [req("a")]), KEY, "a", by).get(KEY)![0], NOW);
    expect(state("terminal")).toBe("terminal");
    expect(state("gone")).toBe("gone");
    expect(state("timeout")).toBe("expired");
    expect(state("nexbot")).toBe("answered");
  });

  it("keeps the decision this page made, and says answered for a question", () => {
    const allowed = markAnswered(setPending(EMPTY_STORE, KEY, [req("a")]), KEY, "a", "allow");
    expect(cardState(allowed.get(KEY)![0], NOW)).toBe("allowed");
    expect(cardState(resolveRequest(allowed, KEY, "a", "nexbot").get(KEY)![0], NOW)).toBe("allowed");
    const denied = markAnswered(setPending(EMPTY_STORE, KEY, [req("a")]), KEY, "a", "deny");
    expect(cardState(denied.get(KEY)![0], NOW)).toBe("denied");
    const asked = markAnswered(setPending(EMPTY_STORE, KEY, [questionRequest({ id: "q" })]), KEY, "q", "allow");
    expect(cardState(asked.get(KEY)![0], NOW)).toBe("answered");
    const always = markAnswered(setPending(EMPTY_STORE, KEY, [req("a")]), KEY, "a", "allow", true);
    expect(cardState(always.get(KEY)![0], NOW)).toBe("always");
    // "always" means nothing for a deny
    expect(cardState(markAnswered(setPending(EMPTY_STORE, KEY, [req("a")]), KEY, "a", "deny", true).get(KEY)![0], NOW)).toBe("denied");
  });

  it("counts only the pending ones", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a"), req("b"), req("c", 1_000)]);
    store = resolveRequest(store, KEY, "b", "terminal");
    expect(pendingCounts(store, NOW).get(KEY)).toBe(1);
    expect(pendingViews(store, NOW).map((view) => view.id)).toEqual(["a"]);
  });

  it("finds the next expiry still ahead and none once all have passed", () => {
    const store = setPending(EMPTY_STORE, KEY, [req("a", 1_000), req("b", NOW + 2_000), req("c", NOW + 9_000)]);
    expect(nextExpiry(store, NOW)).toBe(NOW + 2_000 + EXPIRY_GRACE_MS + 1);
    expect(nextExpiry(store, NOW + 20_000)).toBeNull();
    expect(nextExpiry(resolveRequest(store, KEY, "b", "terminal"), NOW)).toBe(NOW + 9_000 + EXPIRY_GRACE_MS + 1);
  });

  it("shows a handled card for a moment above the box, then lets it go", () => {
    let store = setPending(EMPTY_STORE, KEY, [req("a"), req("b")]);
    store = markAnswered(store, KEY, "a", "allow");
    const records = store.get(KEY)!;
    const closedAt = records.find((record) => record.view.id === "a")!.closedAt!;
    expect(shownCards(records, closedAt).map((record) => record.view.id)).toEqual(["b", "a"]);
    expect(shownCards(records, closedAt + CLOSED_SHOW_MS).map((record) => record.view.id)).toEqual(["b"]);
    // the clock wakes up when it leaves
    expect(nextExpiry(setPending(store, KEY, []), closedAt)).toBe(closedAt + CLOSED_SHOW_MS + 1);
  });
});

describe("questions", () => {
  const view = questionRequest();
  const questions = view.questions!;

  it("lets one option be chosen for a single choice and several for a multi choice", () => {
    let selection = toggleChoice({}, 0, "React", false);
    selection = toggleChoice(selection, 0, "Vue", false);
    expect(selection[0]).toEqual(["Vue"]);
    selection = toggleChoice(selection, 1, "路由", true);
    selection = toggleChoice(selection, 1, "测试", true);
    selection = toggleChoice(selection, 1, "路由", true);
    expect(selection[1]).toEqual(["测试"]);
  });

  it("is complete only when every question has an answer", () => {
    expect(answersComplete(questions, {})).toBe(false);
    expect(answersComplete(questions, { 0: ["React"] })).toBe(false);
    expect(answersComplete(questions, { 0: ["React"], 1: ["路由"] })).toBe(true);
    expect(answersComplete(undefined, {})).toBe(false);
  });

  it("answers by question text with several labels joined in option order", () => {
    expect(answersFor(questions, { 0: ["Vue"], 1: ["测试", "路由"] })).toEqual({ "用哪个框架？": "Vue", "要哪些功能？": "路由, 测试" });
  });

  it("supports custom OTHER_CHOICE text for single and multi choice questions", () => {
    expect(answersComplete(questions, { 0: [OTHER_CHOICE], 1: ["路由"] }, { 0: "   " })).toBe(false);
    expect(answersComplete(questions, { 0: [OTHER_CHOICE], 1: ["路由"] }, { 0: "Svelte" })).toBe(true);
    expect(answersComplete(questions, { 0: [OTHER_CHOICE], 1: ["路由", OTHER_CHOICE] }, { 0: "Svelte", 1: "" })).toBe(true);
    expect(answersFor(questions, { 0: [OTHER_CHOICE], 1: ["路由", OTHER_CHOICE] }, { 0: " Svelte ", 1: " 深色模式 " }))
      .toEqual({ "用哪个框架？": "Svelte", "要哪些功能？": "路由, 深色模式" });
  });
});

describe("waiting sessions and notifications", () => {
  it("counts a session with a pending request as waiting once", () => {
    const sessions = [session({ nativeId: "1", state: "waiting" }), session({ nativeId: "2", state: "running" }), session({ nativeId: "3", state: "idle" })];
    expect(waitingCount(sessions)).toBe(1);
    expect(waitingCount(sessions, new Set([sessions[0].key, sessions[1].key]))).toBe(2);
    expect(askedSession(sessions[1], 1).state).toBe("waiting");
    expect(askedSession({ ...sessions[1], online: false }, 1).state).toBe("running");
  });

  it("finds new requests and nothing on the first look", () => {
    const pending = [req("a"), req("b")];
    expect(newRequests(null, pending)).toEqual([]);
    expect(newRequests(new Set(["a"]), pending).map((view) => view.id)).toEqual(["b"]);
  });

  it("writes the notification text from the tool or the first question", () => {
    expect(requestBody(permissionRequest({ tool: "Bash", summary: "ls\n  -la" }))).toBe("Bash ls -la");
    expect(requestBody(questionRequest())).toBe("用哪个框架？");
    expect(requestBody(permissionRequest({ tool: "", summary: "" }))).toBe("等你处理");
    expect(requestBody(permissionRequest({ summary: "x".repeat(200) })).length).toBe(80);
  });
});
