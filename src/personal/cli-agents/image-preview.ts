import { CLI_HISTORY_IMAGE_MAX } from "../../../shared/cli-agents";

/** The bytes produced here are the only image payload sent by the web, desktop and Android composers. */
export async function compressPickedImage(file: File): Promise<Blob> {
  if (!file.size || file.size > 32 * 1024 * 1024) throw new Error("请选择 32 MB 以内的图片");
  const image = await createImageBitmap(file).catch(() => { throw new Error("无法读取所选图片"); });
  try {
    const canvas = document.createElement("canvas");
    for (const edge of [1920, 1440, 1024, 640]) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const preview = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.8));
      if (preview && preview.size > 0 && preview.size <= CLI_HISTORY_IMAGE_MAX) return preview;
    }
    throw new Error("图片压缩失败");
  } finally { image.close(); }
}
