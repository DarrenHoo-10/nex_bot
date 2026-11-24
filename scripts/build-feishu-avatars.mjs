import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { companionColors, companionShapes, graphicAvatarIds, portraitIds, qAvatarIds } from "../shared/personal-appearance.ts";
import { graphicAvatarData } from "../shared/personal-graphic-avatars.ts";
import { qCrop, qFrame } from "../src/personal/q-avatar-motion.ts";
import { colors } from "../src/personal/avatars/appearance.ts";

const require = createRequire(import.meta.url);
const pdfRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
const { createCanvas, loadImage } = pdfRequire("@napi-rs/canvas");

export async function buildFeishuAvatars(root, ui) {
  const output = path.join(ui, "feishu-avatars");
  const assets = path.join(root, "src/personal/avatars");
  const companions = path.join(root, "public/companions");
  await mkdir(output, { recursive: true });
  const sprites = JSON.parse(await readFile(path.join(assets, "character-sprites.json"), "utf8"));
  const images = new Map();
  const size = 256;
  async function save(name, source, crop) {
    if (!images.has(source)) images.set(source, readFile(source).then(loadImage));
    const image = await images.get(source);
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");
    context.drawImage(image, ...(crop ?? [0, 0, image.width, image.height]), 0, 0, size, size);
    await writeFile(path.join(output, name + ".png"), canvas.toBuffer("image/png"));
  }
  for (const id of portraitIds) await save("portrait-" + id, path.join(assets, id + ".svg"));
  for (const id of graphicAvatarIds) {
    const { sheet, crop } = graphicAvatarData[id];
    await save("graphic-" + id, path.join(assets, "graphic", sheet.id + ".png"), crop);
  }
  for (const id of qAvatarIds) {
    if (id === "blue-maid") {
      const { action, column } = qFrame(0, 0);
      const { sheet, viewBox } = qCrop(action, column, true);
      await save("q-" + id, path.join(companions, "blue-q", sheet.file), viewBox.split(" ").map(Number));
    } else {
      const [x, y, width] = sprites.idle.frames[sprites.characters[id].idleColumn];
      const side = width * .68;
      await save("q-" + id, path.join(companions, "cast", sprites.idle.file), [x + (width - side) / 2, y, side, side]);
    }
  }
  const radii = { soft: 48, bean: 74, pebble: 72, bud: 45 };
  for (const shape of companionShapes) {
    for (const color of companionColors) {
      const canvas = createCanvas(size, size);
      const context = canvas.getContext("2d");
      context.fillStyle = colors[color].value;
      context.beginPath();
      context.roundRect(28, 35, 200, 182, radii[shape]);
      context.fill();
      context.fillStyle = "#fff";
      for (const x of [102, 154]) {
        context.beginPath();
        context.ellipse(x, 124, 10, 14, 0, 0, 2 * Math.PI);
        context.fill();
      }
      await writeFile(path.join(output, "companion-" + shape + "-" + color + ".png"), canvas.toBuffer("image/png"));
    }
  }
}
