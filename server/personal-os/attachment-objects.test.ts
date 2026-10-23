import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OssAttachmentObjects, type AttachmentObjects } from './attachment-objects.ts';
import { createPersonalApp } from './index.ts';
import { ChatFiles } from './chat-files.ts';
import { ClientIdentity } from './clients.ts';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-oss-fixture-')), key = randomBytes(32), token = 'synthetic-owner';
  closes.push(async () => { if (path.dirname(dir).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(dir).startsWith('nex-oss-fixture-')) throw new Error('Unsafe cleanup'); rmSync(dir, { recursive: true, force: true }); });
  const objects = new Map<string, string>(); let fail = false, corrupt = false, reads = 0, beforeRead: (() => void) | undefined;
  const storage: AttachmentObjects = { async put(key, value) { if (fail) throw new Error('Synthetic offline'); objects.set(key, value); }, async get(key) { reads++; beforeRead?.(); return corrupt ? 'corrupt' : objects.get(key)!; }, async delete(key) { objects.delete(key); } };
  const options = { dir, key, token, identity: false as const, memoryRuntime: false as const, hostDevice: false as const };
  let app = await createPersonalApp(options); closes.push(() => app.close());
  const bot = app.store.createBot('Attachment fixture');
  const publish = () => {
    const files = new ChatFiles(app.store), file = files.upload({ botId: bot, name: 'private.txt', data: Buffer.from('private fixture content').toString('base64') }, app.store.session);
    app.agents.publish(bot, 'user', 'message', `[file](/api/attachments/${file.id})`, `fixture:${file.id}`);
    const message = app.store.get('SELECT id FROM agent_messages WHERE source_key=?', `fixture:${file.id}`)!;
    app.store.run('UPDATE chat_attachments SET message_id=? WHERE id=?', message.id, file.id);
    return file;
  };
  return { get app() { return app; }, bot, token, publish, storage, objects, get reads() { return reads; }, fail(value: boolean) { fail = value; }, corrupt(value: boolean) { corrupt = value; }, beforeRead(fn: () => void) { beforeRead = fn; }, async restart() { await app.close(); app = await createPersonalApp({ ...options, attachmentObjects: storage }); } };
}

it('migrates encrypted attachments, preserves links, survives restart and serves a second device only after authentication', async () => {
  const f = await fixture(), file = f.publish(), files = new ChatFiles(f.app.store);
  const before = await files.file(file.id);
  f.app.store.attachmentObjects = f.storage;
  await files.migrate();
  expect(f.objects.size).toBe(1);
  expect([...f.objects.values()][0]).not.toContain('private fixture content');
  expect(f.app.store.get('SELECT ciphertext FROM chat_attachments WHERE id=?', file.id)?.ciphertext).toBe('');
  expect((await files.file(file.id)).bytes).toEqual(before.bytes);
  await f.restart();
  const clients = new ClientIdentity(f.app.store), second = clients.login(clients.invite('Device B').code, 'Device B');
  const url = `${f.app.origin}/api/attachments/${file.id}`, count = f.reads;
  expect((await fetch(url)).status).toBe(401); expect(f.reads).toBe(count);
  const download = await fetch(url, { headers: { Authorization: `Bearer ${second.token}` } });
  expect(download.status).toBe(200); expect(await download.text()).toBe('private fixture content');
  clients.revoke(second.sessionId);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(401);
  const peer = f.app.store.createBot('Peer');
  await expect(new ChatFiles(f.app.store).file(file.id, peer)).rejects.toThrow('不可访问');
});

it('retains local data on upload or verification failure, retries idempotently and checks redaction after remote reads', async () => {
  const f = await fixture(), file = f.publish(), files = new ChatFiles(f.app.store);
  f.app.store.attachmentObjects = f.storage; f.fail(true);
  await expect(files.persist(file.id)).rejects.toThrow('offline');
  expect(f.app.store.get('SELECT ciphertext FROM chat_attachments WHERE id=?', file.id)?.ciphertext).toBeTruthy();
  f.fail(false); f.corrupt(true);
  await expect(files.persist(file.id)).rejects.toThrow('校验失败');
  expect(f.app.store.all('SELECT * FROM attachment_objects')).toHaveLength(0);
  f.corrupt(false); await Promise.all([files.persist(file.id), files.persist(file.id)]);
  expect(f.objects.size).toBe(1);
  f.corrupt(true); await expect(files.file(file.id)).rejects.toThrow('完整性'); f.corrupt(false);
  f.beforeRead(() => f.app.store.run("UPDATE agent_messages SET content='[redacted]'"));
  await expect(files.file(file.id)).rejects.toThrow('不可访问');
});

it('signs OSS writes with private ACL, bounded safe keys, checksums and safe failure messages', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(init?.method === 'GET' ? 'ciphertext' : '', { status: 200 }); };
  const config = { endpoint: 'oss-cn-beijing.aliyuncs.com', bucket: 'fixture-bucket', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' };
  const oss = new OssAttachmentObjects(config, transport), key = `nexbot/attachments/v1/${'a'.repeat(64)}/01234567.enc`;
  await oss.put(key, 'ciphertext'); expect(await oss.get(key)).toBe('ciphertext');
  await oss.delete(key); expect(calls.at(-1)?.init.method).toBe('DELETE');
  const headers = new Headers(calls[0].init.headers), md5 = createHash('md5').update('ciphertext').digest('base64');
  const canonical = `PUT\n${md5}\napplication/octet-stream\n${headers.get('Date')}\nx-oss-forbid-overwrite:true\nx-oss-object-acl:private\n/fixture-bucket/${key}`;
  expect(headers.get('Authorization')).toBe('OSS synthetic-id:' + createHmac('sha1', config.accessKeySecret).update(canonical).digest('base64'));
  expect(headers.get('x-oss-object-acl')).toBe('private');
  expect(calls[0].init.redirect).toBe('error'); expect(calls[0].url).toBe(`https://fixture-bucket.oss-cn-beijing.aliyuncs.com/${key}`);
  await expect(oss.get('../other')).rejects.toThrow('路径');
  const failed = new OssAttachmentObjects(config, async () => new Response('secret-do-not-leak', { status: 403 }));
  await expect(failed.get(key)).rejects.toThrow('附件存储返回 HTTP 403');
  expect(OssAttachmentObjects.fromEnvironment({})).toBeUndefined();
});
