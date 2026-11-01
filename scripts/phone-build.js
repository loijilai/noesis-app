import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeck } from '../server/deck.js';
import { readEvents } from '../server/progress.js';
import { dataPaths, loadConfig } from '../server/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { deckDir, progressDir } = dataPaths(loadConfig());
const out = path.join(root, 'phone/dist/index.html');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const deck = await loadDeck(deckDir);
// Events of deleted cards ride along for the practice graph; the backend leaves them out of everything else.
const events = (await readEvents(progressDir)).map(({ device, ...event }) => event);

// The Artifact viewer only serves the page itself, so images and stylesheets are inlined.
// Card text keeps its asset paths, so a card edited on the phone can be written back as is; the page swaps in the images when it shows a card.
const IMAGE_WARN_BYTES = 500e3;
const ARTIFACT_LIMIT_BYTES = 16e6;
const images = {};
const bigImages = [];
const texts = deck.cards.map((c) => c.raw).join('\n');
for (const file of await readdir(path.join(deckDir, 'assets')).catch(() => [])) {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type || !texts.includes(`../assets/${file}`)) continue;
  const bytes = await readFile(path.join(deckDir, 'assets', file));
  if (bytes.length > IMAGE_WARN_BYTES) bigImages.push(`${file}（${(bytes.length / 1e3).toFixed(0)} KB）`);
  images[`../assets/${file}`] = `data:${type};base64,${bytes.toString('base64')}`;
}
const data = JSON.stringify({ deck, events, images });

const bundle = await build({
  entryPoints: [path.join(root, 'phone/entry.js')],
  bundle: true,
  format: 'esm',
  external: ['https://*'],
  write: false,
  logLevel: 'warning',
});
const css = [
  await readFile(path.join(root, 'node_modules/highlight.js/styles/github.min.css'), 'utf8'),
  await readFile(path.join(root, 'public/style.css'), 'utf8'),
].join('\n');

const icon = await readFile(path.join(root, 'public/apple-touch-icon.png'));
const html = (await readFile(path.join(root, 'public/index.html'), 'utf8'))
  .replace(/<link rel="stylesheet"[^>]*>\n/g, '')
  .replace('href="/apple-touch-icon.png"', () => `href="data:image/png;base64,${icon.toString('base64')}"`)
  .replace('</head>', () => `<style>\n${css}</style>\n</head>`)
  .replace(/<script type="module" src="\/app.js"><\/script>/, () => [
    `<script type="application/json" id="noesis-data">${data.replaceAll('<', '\\u003c')}</script>`,
    `<script type="module">\n${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`,
  ].join('\n'));
if (!html.includes('id="noesis-data"')) throw new Error('public/index.html 的 <script> 跟預期不同，無法打包');
const size = Buffer.byteLength(html);
if (size > ARTIFACT_LIMIT_BYTES) {
  throw new Error(`手機版 ${(size / 1e6).toFixed(1)} MB，超過 Artifact 上限 16 MB，無法發布${bigImages.length ? `。先縮小這些圖：${bigImages.join('、')}` : ''}`);
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, html);
const hash = createHash('sha256').update(html).digest('hex');
console.log(`noesis: ${path.relative(root, out)}（${deck.cards.length} 張卡、${events.length} 筆紀錄、${(size / 1e6).toFixed(1)} MB）`);
console.log(`sha256: ${hash}`);
if (bigImages.length) console.warn(`警告：這些圖超過 500 KB，會讓手機版變大，建議縮到長邊 1600px：${bigImages.join('、')}`);
