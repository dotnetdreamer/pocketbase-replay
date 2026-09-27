import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Hashed chunk names change between builds; stale ones would ship in the package.
rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  entryPoints: [`${root}src/index.ts`], outdir: `${root}dist`,
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'chrome91',
  external: ['@rrweb/record', 'fflate'], legalComments: 'eof',
});
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', `${root}tsconfig.json`], { stdio: 'inherit' });
console.log('Replay client built');
