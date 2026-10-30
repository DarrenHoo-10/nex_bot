import type { RecordRow } from "./api";

/** A local row shown until the server copy of this send arrives. */
export function optimisticOutgoing(clientId: string, content: string, createdAt = Date.now()): RecordRow {
  return { id: `optimistic:${clientId}`, role: "user", kind: "message", content, created_at: createdAt, seq: 0 };
}

/** The receipt replaces data, not the already visible message element. */
export function transcriptMessageKey(message: RecordRow): string {
  const source = String(message.source_key ?? "");
  return message.role === "user" && source.startsWith("agent-input:")
    ? `optimistic:${source.slice(source.lastIndexOf(":") + 1)}`
    : String(message.id);
}

/**
 * Keep unsent local rows when a refetch replaces the list. The server copy is
 * the row whose source key ends with this send's client id (attachment links
 * can change the text). Text is only a fallback when the row has no key, so a
 * second send of the same sentence stays visible.
 */
export function withPendingOptimistic(server: readonly RecordRow[], shown: readonly RecordRow[]): RecordRow[] {
  const pending = shown.filter((message) => {
    const id = String(message.id ?? "");
    if (!id.startsWith("optimistic:")) return false;
    const clientId = id.slice("optimistic:".length);
    return !server.some((row) => {
      if (row.role !== message.role) return false;
      const key = row.source_key == null ? "" : String(row.source_key);
      if (key.endsWith(`:${clientId}`)) return true;
      return key === "" && String(row.content) === String(message.content);
    });
  });
  return [...server, ...pending];
}

/**
 * A live bubble whose text is already the committed assistant row would vanish
 * again when the worker drops it. Keep the committed row only.
 */
export function withoutCommittedStreaming<T extends { taskId: string; text: string }>(messages: readonly RecordRow[], streaming: readonly T[]): T[] {
  return streaming.filter((item) => item.text && !messages.some((message) => message.role === "assistant" && String(message.task_id ?? "") === item.taskId && String(message.content ?? "") === item.text));
}

interface ClipboardFileItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** Image files from a paste. Text-only clipboards return an empty list. */
export function imageFilesFromClipboard(clipboardData: { items?: ArrayLike<ClipboardFileItem> | null; files?: ArrayLike<File> | null } | null): File[] {
  if (!clipboardData) return [];
  const fromItems = imageFilesFromItems(clipboardData.items);
  if (fromItems.length) return fromItems;
  const files = clipboardData.files;
  if (!files?.length) return [];
  const images: File[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const named = namedImageFile(files[index], files[index].type);
    if (named) images.push(named);
  }
  return images;
}

function imageFilesFromItems(items: ArrayLike<ClipboardFileItem> | null | undefined): File[] {
  if (!items?.length) return [];
  const images: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const named = namedImageFile(file, item.type);
    if (named) images.push(named);
  }
  return images;
}

function namedImageFile(file: File, itemType: string): File | null {
  const mime = file.type || itemType;
  if (!mime.startsWith("image/")) return null;
  const extension = mime === "image/jpeg" || mime === "image/jpg" ? "jpg" : (mime.slice("image/".length).replace(/[^a-z0-9]+/gi, "") || "png");
  const name = file.name.trim() || `截图.${extension}`;
  if (file.name === name && file.type === mime) return file;
  return new File([file], name, { type: mime, lastModified: file.lastModified });
}
