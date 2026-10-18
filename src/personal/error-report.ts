/** Plain-DOM error report so a failure is visible even when React or the stylesheet is what broke. */

const LINES = 8;

function firstLines(text: string, count = LINES) {
  return text.split("\n").map((line) => line.trim().slice(0, 200)).filter(Boolean).slice(0, count).join("\n");
}

/** A copyable description of a failure: what threw, where, and in which environment. */
export function describeError(error: unknown, componentStack = ""): string {
  let head: string, stack = "";
  if (error instanceof Error) {
    head = `${error.name}: ${error.message}`;
    stack = firstLines((error.stack ?? "").replace(head, ""));
  } else if (typeof error === "string") head = error;
  else {
    try { head = JSON.stringify(error) ?? String(error); } catch { head = String(error); }
  }
  const where = typeof location === "undefined" ? "" : `${location.pathname}${location.hash ? "#…" : ""}`;
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  return [head.slice(0, 600), stack, componentStack && `组件：\n${firstLines(componentStack)}`, [where, agent].filter(Boolean).join("\n")]
    .filter(Boolean).join("\n\n");
}

/** Replaces the root's content with the error, using only DOM text nodes. */
export function showBootError(root: HTMLElement, details: string) {
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText = "box-sizing:border-box;min-height:100%;padding:24px 16px;font:14px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText";
  const title = document.createElement("h1");
  title.textContent = "NexBot 界面出错了";
  title.style.cssText = "margin:0 0 8px;font-size:18px";
  const hint = document.createElement("p");
  hint.textContent = "请把下面的内容截图或复制发给开发者。";
  hint.style.cssText = "margin:0 0 12px;opacity:.7";
  const pre = document.createElement("pre");
  pre.textContent = details;
  pre.style.cssText = "margin:0 0 16px;padding:12px;border-radius:8px;border:1px solid GrayText;white-space:pre-wrap;word-break:break-word;user-select:text;font:12px/1.5 ui-monospace,monospace";
  const reload = document.createElement("button");
  reload.textContent = "重新加载";
  reload.style.cssText = "padding:8px 16px;font:inherit";
  reload.onclick = () => location.reload();
  panel.append(title, hint, pre, reload);
  root.replaceChildren(panel);
}
