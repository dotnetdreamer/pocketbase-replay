import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// tsc leaves the output of deleted sources behind, and it would ship in the package.
rmSync(`${root}dist`, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', `${root}tsconfig.json`], { stdio: 'inherit' });
console.log('Capacitor plugin built');
