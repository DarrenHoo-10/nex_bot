// Scales the local system CJK font to span exact 2 monospace cells (adapted
// from Persona's cjk.ts) and waits briefly for fonts before xterm measures cells.
import { withFamily } from "./terminal-logic";

const FAMILY = "NexTermCJK";
const LOCAL = [
  "PingFang SC Regular", "PingFangSC-Regular",
  "Hiragino Sans GB W3", "HiraginoSansGB-W3",
  "Microsoft YaHei", "MicrosoftYaHei",
  "Noto Sans CJK SC Regular", "NotoSansCJKsc-Regular",
  "Noto Sans SC Regular", "NotoSansSC-Regular",
  "Source Han Sans SC Regular", "SourceHanSansSC-Regular",
  "WenQuanYi Micro Hei",
];
const RANGES =
  "U+1100-115F, U+2E80-303E, U+3041-33FF, U+3400-4DBF, U+4E00-9FFF, U+A000-A4CF, U+AC00-D7A3, U+F900-FAFF, U+FE30-FE4F, U+FF00-FF60, U+FFE0-FFE6, U+20000-2FFFD, U+30000-3FFFD";

export const BASE_TERMINAL_FONT_STACK =
  '"JetBrains Mono", "SF Mono", "Cascadia Mono", ui-monospace, SFMono-Regular, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

const cache = new Map<string, Promise<string | null>>();

function measure(family: string, text: string): number {
  const span = document.createElement("span");
  span.textContent = text;
  span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:${family};left:-9999px;top:0`;
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width;
  span.remove();
  return w;
}

async function load(stack: string): Promise<string | null> {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return null;
  const src = LOCAL.map((n) => `local("${n}")`).join(", ");
  const probeName = `${FAMILY}Probe`;
  const probe = new FontFace(probeName, src, { unicodeRange: RANGES });
  await probe.load();
  document.fonts.add(probe);
  const cell = measure(stack, "W".repeat(20)) / 20;
  const glyph = measure(`"${probeName}"`, "中".repeat(10)) / 10;
  document.fonts.delete(probe);
  if (!(cell > 0 && glyph > 0)) return null;
  const scale = (2 * cell) / glyph;
  if (scale < 1.02) return null;
  const face = new FontFace(FAMILY, src, {
    unicodeRange: RANGES,
    sizeAdjust: `${(scale * 100).toFixed(2)}%`,
  } as FontFaceDescriptors);
  await face.load();
  document.fonts.add(face);
  return withFamily(stack, FAMILY);
}

export function cjkFontStack(stack: string = BASE_TERMINAL_FONT_STACK): Promise<string | null> {
  let pending = cache.get(stack);
  if (!pending) {
    pending = load(stack).catch(() => null);
    cache.set(stack, pending);
  }
  return pending;
}

const FONT_WAIT_MS = 1500;

export function terminalFontReady(size: number, stack: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FONT_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    document.fonts.load(`${size}px ${stack}`, "W中").then(done, done);
  });
}
