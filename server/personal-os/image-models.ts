import { normalizeImageGenerationUrl } from '../../shared/image-generation.ts';
import { decodeGeneratedImage } from '../generated-image.ts';
import { attachmentLimit } from './chat-files.ts';
import { text, type CoreStore } from './store.ts';

export class ImageModels {
  constructor(readonly store: CoreStore) {}
  list() {
    if (this.store.config()?.provider_id !== 'openai') return [];
    return this.store.imageModelSelection().models.map(model => ({ id: model, name: model, model }));
  }
  select(modelId?: unknown) {
    const models = this.list();
    const row = modelId === undefined ? models[0] : models.find(model => model.id === text(modelId, 200));
    if (!row) throw new Error(modelId === undefined ? '请先在设置的模型页选择生图模型' : '此模型未被选为生图模型，请重新读取模型列表');
    return row;
  }
  async generate(args: Record<string, unknown>, signal: AbortSignal) {
    const row = this.select(args.modelId), prompt = text(args.prompt, 16000);
    const connection = this.store.modelConfig(), selectionVersion = this.store.imageModelSelection().version;
    const size = args.size === undefined ? '1024x1024' : text(args.size, 30);
    if (!['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(size)) throw new Error('不支持的图片尺寸');
    const endpoint = normalizeImageGenerationUrl(connection.endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    headers.Authorization = `Bearer ${connection.apiKey}`;
    const timeout = AbortSignal.timeout(180000), combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(endpoint + '/images/generations', { method: 'POST', headers, redirect: 'error', signal: combined,
        body: JSON.stringify({ model: row.model, prompt, n: 1, size, ...(/^gpt-image(?:-|$)/.test(String(row.model)) ? {} : { response_format: 'b64_json' }) }) });
    } catch { throw new Error(signal.aborted ? '生图已停止' : timeout.aborted ? '生图请求超时' : '无法连接生图服务'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`生图服务返回 HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('生图服务未返回图片');
    const chunks: Uint8Array[] = []; let received = 0;
    const limit = Math.ceil(attachmentLimit / 3) * 4 + 65536;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) { await reader.cancel(); throw new Error('生成的图片超过 5 MB'); }
        chunks.push(value);
      }
    } catch (error) {
      if (combined.aborted) throw new Error(signal.aborted ? '生图已停止' : '生图请求超时');
      if (received > limit) throw error;
      throw new Error('读取生图结果失败');
    } finally { reader.releaseLock(); }
    let encoded: unknown;
    try { encoded = JSON.parse(Buffer.concat(chunks).toString('utf8')).data?.[0]?.b64_json; }
    catch { throw new Error('生图服务返回了无效响应'); }
    // Never follow provider-returned URLs or forward credentials to them.
    if (typeof encoded !== 'string') throw new Error('生图服务须返回 b64_json 图片数据');
    let image: ReturnType<typeof decodeGeneratedImage>;
    try { image = decodeGeneratedImage(encoded); } catch { throw new Error('生图服务返回了无效图片'); }
    if (image.bytes.length > attachmentLimit) throw new Error('生成的图片超过 5 MB');
    if (image.mime === 'image/gif') throw new Error('生图服务须返回 PNG、JPEG 或 WebP 图片');
    this.select(row.id);
    if (this.store.modelConfig().version !== connection.version || this.store.imageModelSelection().version !== selectionVersion) throw new Error('模型连接或生图选择已变化，请重新生成');
    signal.throwIfAborted();
    return { ...image, modelId: String(row.id), model: String(row.model) };
  }
}
