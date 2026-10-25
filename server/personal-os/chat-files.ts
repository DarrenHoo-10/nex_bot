import { hash, id, now, text, type CoreStore } from "./store.ts";

export const attachmentLimit = 5 * 1024 * 1024;
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "rejected"]);

/** Remove one attachment's inline image/link reference from a message body. */
export function withoutAttachmentReference(content: string, fileId: string): string {
  const url = `/api/attachments/${text(fileId, 100)}`;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`!?\\[[^\\]\\n]*\\]\\(\\s*${escaped}(?:\\?[^)\\s]*)?(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'))?\\s*\\)`, "g");
  const cleaned = content
    .replace(reference, "")
    .replace(/^[ \t]{0,3}>[ \t]*$/gm, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "")
    .replace(/[ \t]+$/, "")
    .replace(/\n{3,}/g, "\n\n");
  return cleaned.trim() ? cleaned : "";
}

export class ChatFiles {
  constructor(readonly store: CoreStore) {}
  upload(data: Record<string, unknown>, sessionId: string) {
    const botId = text(data.botId, 100), name = text(data.name, 200).replace(/[\\/\r\n\0]/g, "_");
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active'", botId)) throw new Error("助手不存在");
    const encoded = text(data.data, Math.ceil(attachmentLimit / 3) * 4);
    if ((encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))) throw new Error("文件编码无效");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > attachmentLimit) throw new Error("文件不能超过 5 MB");
    this.store.run("DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at<?", now() - 86400_000);
    if (Number(this.store.get("SELECT COALESCE(SUM(size),0) n FROM chat_attachments")?.n) + bytes.length > 200 * 1024 * 1024) throw new Error("附件空间已满");
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.subarray(0, 4).toString() === "%PDF" ? "application/pdf" : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP" ? "image/webp" : "application/octet-stream";
    const file = { id: id(), botId, name, mime, size: bytes.length };
    this.store.insert("chat_attachments", { id: file.id, bot_id: botId, session_id: sessionId, name, mime, size: bytes.length, ciphertext: this.store.encrypt(encoded), created_at: now(), message_id: null });
    return file;
  }
  references(botId: string, ids: unknown, sessionId: string) {
    if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error("最多添加 5 个附件");
    return ids.map((value) => {
      const row = this.store.get("SELECT id,name,session_id FROM chat_attachments WHERE id=? AND bot_id=?", text(value,100), botId);
      if (!row || row.session_id !== sessionId) throw new Error("附件不可用，请重新上传");
      return `[${String(row.name).replace(/[[\]\\]/g, "_")}](/api/attachments/${row.id})`;
    }).join("\n");
  }
  bind(ids: string[], botId: string, clientId: string) {
    const message = this.store.get("SELECT id FROM agent_messages WHERE source_key=?", `agent-input:${botId}:${clientId}`);
    if (!message) throw new Error("附件消息未保存");
    for (const fileId of ids) this.store.run("UPDATE chat_attachments SET message_id=? WHERE id=? AND bot_id=? AND message_id IS NULL", message.id, fileId, botId);
  }
  authorize(fileId: string, botId?: string) {
    const row = this.store.get("SELECT a.* FROM chat_attachments a JOIN agent_messages m ON m.id=a.message_id WHERE a.id=? AND instr(m.content,'/api/attachments/'||a.id)>0", fileId);
    if (!row || (botId && row.bot_id !== botId)) throw new Error("附件不存在或不可访问");
    return row;
  }
  objectKey(fileId: string) {
    const core = this.store.get('SELECT core_id FROM workspaces')!.core_id;
    return `nexbot/attachments/v1/${hash(String(core))}/${text(fileId, 100)}.enc`;
  }
  persist(fileId: string): Promise<void> {
    const pending = this.store.attachmentJobs.get(fileId); if (pending) return pending;
    const objects = this.store.attachmentObjects; if (!objects) return Promise.resolve();
    const job = (async () => {
      const row = this.store.get('SELECT ciphertext FROM chat_attachments WHERE id=?', fileId);
      if (!row || !row.ciphertext) return;
      const ciphertext = String(row.ciphertext), key = this.objectKey(fileId), digest = hash(ciphertext);
      await objects.put(key, ciphertext);
      if (hash(await objects.get(key)) !== digest) throw new Error('附件上传校验失败');
      this.store.transaction(() => {
        if (this.store.get('SELECT ciphertext FROM chat_attachments WHERE id=?', fileId)?.ciphertext !== ciphertext) return;
        this.store.run('INSERT INTO attachment_objects VALUES(?,?,?) ON CONFLICT(attachment_id) DO UPDATE SET object_key=excluded.object_key,ciphertext_hash=excluded.ciphertext_hash', fileId, key, digest);
        this.store.run("UPDATE chat_attachments SET ciphertext='' WHERE id=?", fileId);
      });
    })();
    this.store.attachmentJobs.set(fileId, job);
    void job.finally(() => this.store.attachmentJobs.delete(fileId)).catch(() => {});
    return job;
  }
  async migrate(shouldStop: () => boolean = () => false) {
    const rows = this.store.all("SELECT id FROM chat_attachments WHERE ciphertext<>'' AND message_id IS NOT NULL LIMIT 20");
    for (const row of rows) { if (shouldStop()) break; await this.persist(String(row.id)); }
    return rows.length;
  }
  async file(fileId: string, botId?: string) {
    let row = this.authorize(fileId, botId), ciphertext = String(row.ciphertext);
    if (!ciphertext) {
      const object = this.store.get('SELECT * FROM attachment_objects WHERE attachment_id=?', fileId);
      if (!object || object.object_key !== this.objectKey(fileId) || !this.store.attachmentObjects) throw new Error('附件存储不可用');
      ciphertext = await this.store.attachmentObjects.get(String(object.object_key));
      if (hash(ciphertext) !== object.ciphertext_hash) throw new Error('附件完整性校验失败');
      row = this.authorize(fileId, botId);
    }
    return { row, bytes: Buffer.from(this.store.decrypt(ciphertext), 'base64') };
  }
  async read(botId: string, fileId: string) {
    const { row, bytes } = await this.file(fileId, botId);
    if (String(row.mime).startsWith("image/")) return { name: row.name, images: [{ type: "image", mimeType: row.mime, data: bytes.toString("base64") }] };
    let content: string;
    if (row.mime === "application/pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
      try {
        const pdf = await loading.promise; content = "";
        for (let page = 1; page <= Math.min(pdf.numPages, 50) && content.length < 80000; page++) content += `\n[${page}]\n` + (await (await pdf.getPage(page)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
      } finally { await loading.destroy(); }
    } else {
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { name: row.name, error: "此格式暂不支持内容解析，可下载原文件" }; }
      if (content.includes("\0")) return { name: row.name, error: "此格式暂不支持内容解析，可下载原文件" };
    }
    return { name: row.name, text: content.slice(0,80000), truncated: content.length > 80000 };
  }
  /** Delete one sent image. Text and other attachments stay in the message;
   * a message that held only this image is removed with its attachment rows. */
  async deleteMessageImage(botId: string, messageId: string, fileId: string) {
    const message = this.store.get("SELECT id,content,task_id FROM agent_messages WHERE id=? AND bot_id=?", messageId, botId);
    if (!message || !String(message.content).includes(`/api/attachments/${fileId}`)) throw new Error("图片不存在或已删除");
    const attachment = this.store.get("SELECT id,mime FROM chat_attachments WHERE id=? AND bot_id=? AND message_id=?", fileId, botId, messageId);
    if (!attachment || !String(attachment.mime).startsWith("image/")) throw new Error("图片不存在或已删除");
    const task = message.task_id ? this.store.get("SELECT status FROM tasks WHERE id=?", String(message.task_id)) : undefined;
    if (task && !TERMINAL_TASK_STATUSES.has(String(task.status))) throw new Error("正在处理，稍后再删除");
    const remaining = withoutAttachmentReference(String(message.content), fileId);
    const objectKeys = this.store.all(
      `SELECT o.object_key FROM chat_attachments a JOIN attachment_objects o ON o.attachment_id=a.id WHERE a.bot_id=? AND ${remaining ? "a.id=?" : "a.message_id=?"}`,
      ...(remaining ? [botId, fileId] : [botId, messageId]),
    ).map((row) => row.object_key).filter((key): key is string => typeof key === "string");
    this.store.transaction(() => {
      if (remaining) {
        this.store.run("UPDATE agent_messages SET content=? WHERE id=? AND bot_id=?", remaining, messageId, botId);
        this.store.run("DELETE FROM chat_attachments WHERE id=? AND bot_id=? AND message_id=?", fileId, botId, messageId);
      } else {
        this.store.run("DELETE FROM chat_attachments WHERE message_id=? AND bot_id=?", messageId, botId);
        this.store.run("DELETE FROM agent_messages WHERE id=? AND bot_id=?", messageId, botId);
      }
    });
    const objects = this.store.attachmentObjects;
    if (objects?.delete) await Promise.all(objectKeys.map((key) => objects.delete!(key).catch(() => undefined)));
    return { deleted: true, messageDeleted: !remaining };
  }
}
