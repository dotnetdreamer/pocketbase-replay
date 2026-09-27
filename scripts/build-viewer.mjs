import { build } from 'esbuild';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = `${root}server/pb_hooks/replay-dash`;
await mkdir(output, { recursive: true });
await build({
  entryPoints: [`${root}viewer/app.ts`],
  outfile: `${output}/app.js`,
  bundle: true, minify: true, format: 'esm', target: 'chrome91',
  legalComments: 'eof',
});
await rename(`${output}/app.css`, `${output}/style.css`);
await copyFile(`${root}viewer/index.html`, `${output}/index.html`);
console.log('Replay dashboard built');
