import { createRequire } from "node:module";
import { CLI_HISTORY_IMAGE_MAX } from "../../shared/cli-agents.ts";
import { cliImageMime } from "../../shared/cli-images.ts";
import { imageDimensions } from "../../shared/provider-icon.ts";

export const maxImageSourceBytes = 32 * 1024 * 1024;

// Both the executor and Core ship the same native canvas alongside pdfjs-dist.
interface Raster { width: number; height: number }
interface CanvasCodec {
  loadImage(bytes: Buffer): Promise<Raster>;
  createCanvas(width: number, height: number): {
    getContext(type: "2d"): { drawImage(image: Raster, x: number, y: number, w: number, h: number): void };
    encode(format: "webp", quality: number): Promise<Buffer>;
  };
}

export async function compressImagePreview(bytes: Buffer): Promise<Buffer> {
  const mime = cliImageMime(bytes);
  const size = mime && imageDimensions(bytes, mime);
  if (!size || !size.width || !size.height || size.width * size.height > 48_000_000 || bytes.length > maxImageSourceBytes) {
    throw new Error("图片尺寸过大或格式无效");
  }
  const require = createRequire(import.meta.url);
  const codec: CanvasCodec = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas");
  const image = await codec.loadImage(bytes);
  const longest = Math.max(image.width, image.height);
  // Preserve transparency and keep screenshot text legible. No original-byte fallback.
  for (const edge of [1920, 1440, 1024, 640]) {
    const scale = Math.min(1, edge / longest);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = codec.createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const preview = await canvas.encode("webp", 80);
    if (preview.length <= CLI_HISTORY_IMAGE_MAX) return preview;
  }
  throw new Error("图片压缩失败");
}
