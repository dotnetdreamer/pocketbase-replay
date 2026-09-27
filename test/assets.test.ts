import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('asset archive copies public images/fonts, preserves versions and excludes app scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-replay-assets-'));
  try {
    const source = join(root, 'dist');
    const target = join(root, 'backend');
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(source, 'fonts'), { recursive: true });
    writeFileSync(join(source, 'assets', 'preview.png'), 'image');
    writeFileSync(join(source, 'fonts', 'ui.woff2'), 'font');
    writeFileSync(join(source, 'assets', 'app.js'), 'app code');
    const script = fileURLToPath(new URL('../scripts/archive-assets.mjs', import.meta.url));
    const run = (version = '1.0.0') => execFileSync(process.execPath, [script, '--from', source, '--target', target, '--version', version], { stdio: 'pipe' });
    run(); run();
    const archive = join(target, 'pb_public', 'replay-assets', '1.0.0');
    assert.equal(readFileSync(join(archive, 'assets', 'preview.png'), 'utf8'), 'image');
    assert.equal(readFileSync(join(archive, 'fonts', 'ui.woff2'), 'utf8'), 'font');
    assert.equal(existsSync(join(archive, 'assets', 'app.js')), false);
    writeFileSync(join(source, 'assets', 'preview.png'), 'new image');
    assert.throws(() => run(), /different asset/);
    assert.equal(readFileSync(join(archive, 'assets', 'preview.png'), 'utf8'), 'image');
    assert.throws(() => run('../escape'), /Invalid version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
