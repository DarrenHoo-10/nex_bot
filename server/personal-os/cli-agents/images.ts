import { createHmac, timingSafeEqual } from "node:crypto";
import { parseCliKey } from "../../../shared/cli-agents.ts";
import { CLI_IMAGE_PREFIX, mapCliImageLinks } from "../../../shared/cli-images.ts";
import { compressImagePreview } from "../image-preview.ts";
import { ChatFiles, attachmentLimit, attachmentMime } from "../chat-files.ts";
import { id, now, type CoreStore } from "../store.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";

const TICKET_TTL = 60 * 60 * 1000;
const UNPUBLISHED_TTL = 24 * 60 * 60 * 1000;

export class CliImages {
  private readonly files: ChatFiles;
  private readonly syncing = new Map<string, Promise<{ mime: string; bytes: Buffer }>>();

  constructor(private readonly store: CoreStore, private readonly key: Buffer) {
    this.files = new ChatFiles(store);
  }

  upload(deviceId: string, origin: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > attachmentLimit) throw new CliOpError("too_large", "图片不能超过 5 MB");
    const mime = attachmentMime(bytes);
    if (!mime.startsWith("image/")) throw new CliOpError("invalid", "请上传 PNG、JPEG 或 WebP 图片");
    const fileId = id(), ciphertext = this.store.encrypt(bytes.toString("base64"));
    this.store.transaction(() => {
      this.store.run("DELETE FROM cli_agent_images WHERE published=0 AND created_at<?", now() - UNPUBLISHED_TTL);
      this.files.checkQuota(bytes.length);
      this.store.insert("cli_agent_images", { id: fileId, device_id: deviceId, origin, mime, size: bytes.length, ciphertext, created_at: now() });
    });
    const job = this.persist(fileId, ciphertext);
    this.store.attachmentJobs.set(fileId, job);
    return job.finally(() => this.store.attachmentJobs.delete(fileId)).then(() => ({ path: CLI_IMAGE_PREFIX + fileId }));
  }

  private async persist(fileId: string, ciphertext: string) {
    if (!this.store.attachmentObjects) return;
    try {
      const { key, digest } = await this.files.writeObject(fileId, ciphertext);
      this.store.run("UPDATE cli_agent_images SET ciphertext='',object_key=?,ciphertext_hash=? WHERE id=?", key, digest, fileId);
    } catch (error) {
      this.store.run("DELETE FROM cli_agent_images WHERE id=?", fileId);
      throw error;
    }
  }

  /** Queue bodies keep stable private paths. Tickets are minted only at delivery. */
  delivery(text: string, deviceId: string): string {
    return mapCliImageLinks(text, (fileId) => {
      const row = this.store.get("SELECT origin FROM cli_agent_images WHERE id=? AND device_id=? AND published=1", fileId, deviceId);
      if (!row) throw new CliOpError("invalid", "图片不可用，请重新上传");
      const expires = now() + TICKET_TTL;
      const url = new URL(CLI_IMAGE_PREFIX + fileId, String(row.origin));
      url.searchParams.set("ticket", `${expires}.${this.signature(fileId, expires)}`);
      return url.href;
    });
  }

  publish(text: string, deviceId: string): void {
    const ids = new Set<string>();
    mapCliImageLinks(text, (fileId) => { ids.add(fileId); return ""; });
    if (ids.size > 5) throw new CliOpError("invalid", "最多添加 5 张图片");
    this.store.transaction(() => {
      for (const fileId of ids) {
        if (this.store.attachmentJobs.has(fileId) ||
            this.store.run("UPDATE cli_agent_images SET published=1 WHERE id=? AND device_id=?", fileId, deviceId).changes !== 1) {
          throw new CliOpError("invalid", "图片不可用，请重新上传");
        }
      }
    });
  }

  private signature(fileId: string, expires: number): string {
    return createHmac("sha256", this.key).update(`nexagent-image:${fileId}:${expires}`).digest("hex");
  }

  validTicket(fileId: string, ticket: string): boolean {
    const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(ticket);
    if (!match) return false;
    const expires = Number(match[1]);
    return expires > now() && timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(this.signature(fileId, expires), "hex"));
  }

  async readForOwner(imageId: string, hub: CliAgentHub, actor: string, origin: string, preview: boolean) {
    const source = this.store.get("SELECT session_key,item_id,locator,file_id FROM cli_history_images WHERE id=?", imageId);
    if (!source) {
      const image = await this.read(imageId);
      if (!image || !preview) return image;
      return { mime: "image/webp", bytes: await compressImagePreview(image.bytes) };
    }
    if (source.file_id) return this.read(String(source.file_id));
    const pending = this.syncing.get(imageId);
    if (pending) return pending;

    const key = String(source.session_key);
    const session = parseCliKey(key);
    if (!session) throw new CliOpError("not_found");
    const sync = async () => {
      const result = await hub.op(actor, session.deviceId, key, "history_image", {
        ref: session.ref, itemId: String(source.item_id), locator: String(source.locator),
      });
      const bytes = Buffer.from(result.data, "base64");
      const uploaded = await this.upload(session.deviceId, origin, bytes);
      const fileId = uploaded.path.slice(CLI_IMAGE_PREFIX.length);
      this.store.transaction(() => {
        if (!this.store.run("UPDATE cli_history_images SET file_id=? WHERE id=?", fileId, imageId).changes) {
          throw new CliOpError("not_found");
        }
        this.store.run("UPDATE cli_agent_images SET published=1 WHERE id=?", fileId);
      });
      return { mime: attachmentMime(bytes), bytes };
    };
    const job = sync().finally(() => this.syncing.delete(imageId));
    this.syncing.set(imageId, job);
    return job;
  }

  async read(fileId: string) {
    const readRow = () => this.store.get("SELECT * FROM cli_agent_images WHERE id=? AND published=1", fileId);
    const row = readRow();
    if (!row) return null;
    const ciphertext = String(row.ciphertext) || await this.files.readObject(fileId, row.object_key, row.ciphertext_hash);
    if (!readRow()) return null;
    return { mime: String(row.mime), bytes: Buffer.from(this.store.decrypt(ciphertext), "base64") };
  }
}
