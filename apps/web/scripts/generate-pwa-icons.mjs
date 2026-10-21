// Renders the installable app's PNG icons from the 48-grid SVG sources in scripts/icons/.
// Run once after the mark changes (`npm run icons -w @projectman/web`); the PNGs are committed.
// `sharp` comes from the repository root (the server depends on it); the web app does not ship it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const source = (name) => readFileSync(here(`./icons/${name}`));
const outDir = here('../public/icons/');
mkdirSync(outDir, { recursive: true });

// Rendered large, then scaled down, so the strokes stay crisp at every size.
async function render(svg, size, file) {
  const png = await sharp(svg, { density: Math.ceil((72 * size * 2) / 48) })
    .resize(size, size)
    .png()
    .toBuffer();
  writeFileSync(file, png);
}

const any = source('icon-any.svg');
const full = source('icon-full.svg');
// any: rounded tile with transparent corners (desktop). maskable: full-bleed square (the OS masks it).
for (const size of [192, 512]) {
  await render(any, size, `${outDir}icon-${size}.png`);
  await render(full, size, `${outDir}icon-maskable-${size}.png`);
}
// Apple touch icon: opaque, because iOS rounds the corners itself.
await render(full, 180, here('../public/apple-touch-icon.png'));
