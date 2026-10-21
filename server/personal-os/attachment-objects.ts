import { createHash, createHmac } from 'node:crypto';

export interface AttachmentObjects {
  put(key: string, ciphertext: string): Promise<void>;
  get(key: string): Promise<string>;
}
const limit = 10 * 1024 * 1024;

/** Private, encrypted objects; never expose OSS credentials or object URLs to clients. */
export class OssAttachmentObjects implements AttachmentObjects {
  readonly origin: string;
  constructor(readonly config: { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string }, readonly transport: typeof fetch = fetch) {
    const endpoint = new URL(config.endpoint.includes('://') ? config.endpoint : `https://${config.endpoint}`);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !/^(?:[a-z0-9-]+\.)?oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint.hostname)) throw new Error('OSS 配置无效');
    const host = endpoint.hostname.startsWith(config.bucket + '.') ? endpoint.hostname : `${config.bucket}.${endpoint.hostname}`;
    this.origin = `https://${host}`;
    if (!config.accessKeyId || !config.accessKeySecret) throw new Error('OSS 凭据缺失');
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env) {
    if (env.NEX_ATTACHMENT_STORAGE !== 'oss') return undefined;
    return new OssAttachmentObjects({ endpoint: env.OSS_ENDPOINT ?? '', bucket: env.OSS_BUCKET ?? '', accessKeyId: env.OSS_ACCESS_KEY_ID ?? '', accessKeySecret: env.OSS_ACCESS_KEY_SECRET ?? '' });
  }
  async request(method: 'PUT' | 'GET', key: string, body?: string) {
    if (!/^nexbot\/attachments\/v1\/[a-f0-9]{64}\/[a-f0-9-]+\.enc$/.test(key)) throw new Error('OSS 对象路径无效');
    if (body !== undefined && Buffer.byteLength(body) > limit) throw new Error('附件对象过大');
    const date = new Date().toUTCString(), mime = body === undefined ? '' : 'application/octet-stream';
    const md5 = body === undefined ? '' : createHash('md5').update(body).digest('base64');
    const ossHeaders = method === 'PUT' ? { 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private' } : {};
    const canonicalHeaders = Object.entries(ossHeaders).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}\n`).join('');
    const signature = createHmac('sha1', this.config.accessKeySecret).update(`${method}\n${md5}\n${mime}\n${date}\n${canonicalHeaders}/${this.config.bucket}/${key}`).digest('base64');
    let response: Response;
    try {
      response = await this.transport(`${this.origin}/${key}`, { method, headers: { Date: date, Authorization: `OSS ${this.config.accessKeyId}:${signature}`, ...ossHeaders, ...(body === undefined ? {} : { 'Content-Type': mime, 'Content-MD5': md5 }) }, body, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch { throw new Error('无法连接附件存储'); }
    if (!response.ok && !(method === 'PUT' && response.status === 409)) { await response.body?.cancel(); throw new Error(`附件存储返回 HTTP ${response.status}`); }
    return response;
  }
  async put(key: string, ciphertext: string) { const response = await this.request('PUT', key, ciphertext); await response.body?.cancel(); }
  async get(key: string) {
    const response = await this.request('GET', key), reader = response.body?.getReader();
    if (!reader) throw new Error('附件存储响应为空');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('附件对象过大'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }
}
