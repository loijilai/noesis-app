import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'phone/dist/index.html');

// One self-contained page: the cards and progress are read from GitHub once it opens, so nothing of the deck is in it.
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
  .replace('</head>', () => '<meta name="apple-mobile-web-app-capable" content="yes">\n</head>')
  .replace('</head>', () => `<style>\n${css}</style>\n</head>`)
  .replace(/<script type="module" src="\/app.js"><\/script>/, () => `<script type="module">\n${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
if (html.includes('src="/app.js"')) throw new Error('public/index.html 的 <script> 跟預期不同，無法打包');

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`noesis: ${path.relative(root, out)}（${(Buffer.byteLength(html) / 1e3).toFixed(0)} KB）`);
