import { describe, expect, it } from "vitest";
import {
  formatFileSize,
  imageDownloadName,
  imageMenuPosition,
  isImageFileName,
  messagePreview,
  parseMessageMedia,
} from "./message-media";

describe("parseMessageMedia", () => {
  it("moves a generated image above the message and drops its download link", () => {
    const parsed = parseMessageMedia("![生成图片](/api/attachments/image-1)\n\n[下载图片](/api/attachments/image-1)");
    expect(parsed.text).toBe("");
    expect(parsed.images).toEqual([{
      id: "image-1",
      url: "/api/attachments/image-1",
      previewUrl: "/api/attachments/image-1?preview=1",
      name: "生成图片.png",
      alt: "生成图片",
    }]);
  });

  it("turns an uploaded image filename chip into a thumbnail and keeps the text", () => {
    const parsed = parseMessageMedia("看下这几个问题还存在吗\n\n[截图.png](/api/attachments/screenshot-1?preview=1)");
    expect(parsed.text).toBe("看下这几个问题还存在吗");
    expect(parsed.images).toEqual([{
      id: "screenshot-1",
      url: "/api/attachments/screenshot-1",
      previewUrl: "/api/attachments/screenshot-1?preview=1",
      name: "截图.png",
      alt: "截图.png",
    }]);
  });

  it("keeps non-image attachments, remote images and ordinary links", () => {
    const source = [
      "报告：[季度报告.pdf](/api/attachments/report-1)",
      "远程图：![示例](https://example.test/image.png)",
      "普通链接：[说明](https://example.test/help)",
    ].join("\n");
    expect(parseMessageMedia(source)).toEqual({ text: source, images: [] });
  });

  it("removes a standalone download link even when no image markdown precedes it", () => {
    expect(parseMessageMedia("[下载图片](/api/attachments/image-2)")).toEqual({ text: "", images: [] });
  });

  it("does not turn examples inside fenced or inline code into thumbnails", () => {
    const inline = "示例：`![生成图片](/api/attachments/inline-1)`";
    expect(parseMessageMedia(inline)).toEqual({ text: inline, images: [] });
    const fenced = "```\n![生成图片](/api/attachments/fenced-1)\n[截图.png](/api/attachments/fenced-2)\n```";
    expect(parseMessageMedia(fenced)).toEqual({ text: fenced, images: [] });
    const indented = "    ![生成图片](/api/attachments/indented-1)";
    expect(parseMessageMedia(indented)).toEqual({ text: indented, images: [] });
  });

  it("deduplicates images repeated by an image and its links", () => {
    const parsed = parseMessageMedia([
      "![生成图片](/api/attachments/image-3)",
      "[下载图片](/api/attachments/image-3)",
      "[截图.png](/api/attachments/image-3?preview=1)",
    ].join("\n\n"));
    expect(parsed.text).toBe("");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].name).toBe("生成图片.png");
  });

  it("keeps a quote while removing the image link from the quote body", () => {
    const parsed = parseMessageMedia("> 引用内容\n\n[截图.jpg](/api/attachments/screenshot-2)");
    expect(parsed.text).toBe("> 引用内容");
    expect(parsed.images[0].name).toBe("截图.jpg");
  });

  it("preserves a Markdown line break away from the removed image", () => {
    const parsed = parseMessageMedia("第一行\n第二行  \n[截图.webp](/api/attachments/screenshot-3)");
    expect(parsed.text).toBe("第一行\n第二行");
    expect(parsed.images).toHaveLength(1);
  });
});

describe("message previews and names", () => {
  it("uses 图片 for an image-only conversation preview", () => {
    expect(messagePreview("![生成图片](/api/attachments/image-4)")).toBe("图片");
    expect(messagePreview("[截图.png](/api/attachments/image-4)\n\n[下载图片](/api/attachments/image-4)")).toBe("图片");
    expect(messagePreview("普通消息\n\n[截图.png](/api/attachments/image-4)")).toBe("普通消息");
  });

  it("normalizes download names without losing the real extension", () => {
    expect(imageDownloadName("截图.PNG")).toBe("截图.PNG");
    expect(imageDownloadName("生成图片")).toBe("生成图片.png");
    expect(imageDownloadName('bad/name:*?"<>|')).toBe("bad_name_______.png");
    expect(imageDownloadName("")).toBe("图片.png");
  });

  it("recognizes only the bitmap types the attachment route previews", () => {
    expect(isImageFileName("截图.png")).toBe(true);
    expect(isImageFileName("截图.JPEG")).toBe(true);
    expect(isImageFileName("动图.gif")).toBe(false);
    expect(isImageFileName("报告.pdf")).toBe(false);
  });

  it("formats file sizes compactly", () => {
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(12 * 1024)).toBe("12 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatFileSize(0)).toBe("");
  });
});

describe("imageMenuPosition", () => {
  it("keeps the menu inside the viewport and flips above the pointer", () => {
    expect(imageMenuPosition(40, 40, 176, 92, 800, 600)).toEqual({ left: 40, top: 40 });
    expect(imageMenuPosition(780, 560, 176, 92, 800, 600)).toEqual({ left: 616, top: 460 });
    expect(imageMenuPosition(-20, -10, 176, 92, 800, 600)).toEqual({ left: 8, top: 8 });
  });
});
