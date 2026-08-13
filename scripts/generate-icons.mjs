import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = await fs.readFile(path.join(root, "www", "icon-source.svg"));

for (const size of [192, 512, 1024]) {
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(path.join(root, "www", `icon-${size}.png`));
}

console.log("Generated Aurora AI icons: 192, 512, 1024");
