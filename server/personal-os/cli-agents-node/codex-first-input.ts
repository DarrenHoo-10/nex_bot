import { open, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// The focused menu option also starts with ›. Accept an *empty composer*, not a
// generic chevron, banner, status, or previously painted prompt in scrollback.
const EMPTY_COMPOSER = /^›(?:\s+(?:Explain this codebase|Summarize recent commits|Implement \{feature\}|Find and fix a bug in @filename|Improve documentation in @filename|Write tests for @filename|Run \/review on my current changes|Use \/skills to list available skills|Ask Codex to do anything|Ask a follow-up question|Message Codex))?$/i;
const IDLE_FOOTER = /^(?:\? for shortcuts\b|\d{1,3}% (?:context )?left\b|(?:gpt-|o[1-9]\b|codex-)[\w.:-]*(?:\s+[^·]*)?\s+·\s+\S)/i;
const DIALOG = /(?:^|\n)\s*(?:›\s*)?\d+[.)]\s|press enter to (?:continue|confirm)|enter to confirm|esc to (?:cancel|interrupt)|do you trust|update available/i;

export function codexEmptyComposer(screen: string): string | null {
  const lines = screen.trimEnd().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The warning badge sits on its own line below the model/worktree footer in 0.172.
  if (/^⚠\s*\d+ warnings?\s*·\s*f2 to view$/i.test(lines.at(-1) ?? "")) lines.pop();
  const footer = lines.at(-1) ?? "";
  const prompt = lines.at(-2) ?? "";
  if (!IDLE_FOOTER.test(footer) || !EMPTY_COMPOSER.test(prompt) || DIALOG.test(lines.slice(-12).join("\n"))) return null;
  return `${prompt}\n${footer}`;
}

/** A read-only receipt on the exact rollout discovered for the native id. Hold
 * the same file open across submission: old records, a replacement file, an
 * assistant echo and a terminal draft are not evidence of this send. */
export async function codexReceipt(file: string | null | undefined) {
  if (!file) return null;
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const start = (await handle.stat()).size;
    const rollout = handle;
    return {
      close: () => rollout.close(),
      async confirmed(text: string, until: number): Promise<boolean> {
        let pos = start;
        let partial: Buffer = Buffer.alloc(0);
        const chunk = Buffer.allocUnsafe(64 * 1024);
        // This is a receipt, not another history reader. An unexpectedly large
        // or unrecognised record yields unconfirmed; never send a second time.
        while (Date.now() < until && pos - start < 4 * 1024 * 1024) {
          const { bytesRead } = await rollout.read(chunk, 0, chunk.length, pos);
          if (!bytesRead) {
            await delay(Math.min(150, Math.max(1, until - Date.now())));
            continue;
          }
          pos += bytesRead;
          const data = Buffer.concat([partial, chunk.subarray(0, bytesRead)]);
          const end = data.lastIndexOf(10);
          if (end >= 0 && data.toString("utf8", 0, end).split("\n").some((line) => matchesCodexInput(line, text))) return true;
          partial = data.subarray(end + 1);
        }
        return false;
      },
    };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

function matchesCodexInput(line: string, text: string): boolean {
  try {
    const { type, payload } = JSON.parse(line);
    if (type !== "event_msg") return false;
    const item = payload?.item;
    const content = payload?.type === "user_message" ? payload.message
      : payload?.type === "item_completed" && item?.type === "UserMessage" && Array.isArray(item.content)
        ? item.content.filter((part: { type?: string } | null) => part?.type?.toLowerCase() === "text").map((part: { text?: string }) => part.text).join("\n") : undefined;
    return typeof content === "string" && content.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
}
