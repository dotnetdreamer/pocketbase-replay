import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const android = fileURLToPath(new URL('../android/', import.meta.url));
const windows = process.platform === 'win32';
// npm runs scripts through cmd.exe on Windows, which cannot start ./gradlew; sh also needs no executable bit.
// The explicit .\ still works where NoDefaultCurrentDirectoryInExePath stops cmd.exe searching the folder.
const result = windows
  ? spawnSync('.\\gradlew.bat', process.argv.slice(2), { cwd: android, stdio: 'inherit', shell: true })
  : spawnSync('sh', ['gradlew', ...process.argv.slice(2)], { cwd: android, stdio: 'inherit' });
process.exit(result.status ?? 1);
