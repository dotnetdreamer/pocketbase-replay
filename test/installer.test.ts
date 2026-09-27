import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));

function install(target: string, ...flags: string[]) {
  return spawnSync(process.execPath, [installer, '--target', target, ...flags], { encoding: 'utf8', windowsHide: true });
}
const dedicatedMigration = 'pb_migrations/1795600001_replay_dedicated.js';

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pb-replay-installer-'));
  try { await run(root); } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, { recursive: true, force: true });
  }
}

test('installer preserves unrelated hooks, migrations, and PocketBase data', async () => {
  await workspace(async root => {
    for (const directory of ['pb_hooks/lib', 'pb_migrations', 'pb_data']) await mkdir(join(root, directory), { recursive: true });
    const files = ['pb_hooks/100_other.pb.js', 'pb_hooks/lib/other.js', 'pb_migrations/123_existing.js', 'pb_data/data.db'];
    for (const path of files) await writeFile(join(root, path), `keep ${path}`);
    const first = install(root);
    assert.equal(first.status, 0, first.stderr || String(first.error));
    for (const path of files) assert.equal(await readFile(join(root, path), 'utf8'), `keep ${path}`);
    assert.ok((await readFile(join(root, 'pb_hooks/700_replay.pb.js'), 'utf8')).includes('/api/replay/start'));
    const second = install(root);
    assert.equal(second.status, 0, second.stderr || String(second.error));
    assert.match(second.stdout, /Installed 0 replay files/);
    await assert.rejects(readFile(join(root, dedicatedMigration)), { code: 'ENOENT' });
  });
});

test('--dedicated also installs the hardening migration next to the replay migration', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'pb_migrations'), { recursive: true });
    await writeFile(join(root, 'pb_migrations/123_existing.js'), 'keep existing');
    const first = install(root, '--dedicated');
    assert.equal(first.status, 0, first.stderr || String(first.error));
    assert.match(await readFile(join(root, dedicatedMigration), 'utf8'), /rateLimits/);
    assert.ok((await readFile(join(root, 'pb_migrations/1795600000_replay.js'), 'utf8')).includes('replay_sessions'));
    assert.equal(await readFile(join(root, 'pb_migrations/123_existing.js'), 'utf8'), 'keep existing');
    assert.deepEqual((await readdir(root)).sort(), ['pb_hooks', 'pb_migrations']);
    const second = install(root, '--dedicated');
    assert.equal(second.status, 0, second.stderr || String(second.error));
    assert.match(second.stdout, /Installed 0 replay files/);
  });
});

test('--dedicated refuses a differing hardening migration before adding any replay files', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'pb_migrations'), { recursive: true });
    await writeFile(join(root, dedicatedMigration), 'keep existing migration');
    const result = install(root, '--dedicated');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Existing file differs/);
    assert.equal(await readFile(join(root, dedicatedMigration), 'utf8'), 'keep existing migration');
    assert.deepEqual(await readdir(join(root, 'pb_migrations')), ['1795600001_replay_dedicated.js']);
    assert.deepEqual(await readdir(root), ['pb_migrations']);
  });
});

test('installer refuses a differing file before adding any replay files', async () => {
  await workspace(async root => {
    await mkdir(join(root, 'pb_hooks'), { recursive: true });
    await writeFile(join(root, 'pb_hooks/700_replay.pb.js'), 'keep existing replay hook');
    const result = install(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Existing file differs/);
    assert.equal(await readFile(join(root, 'pb_hooks/700_replay.pb.js'), 'utf8'), 'keep existing replay hook');
    assert.deepEqual(await readdir(join(root, 'pb_hooks')), ['700_replay.pb.js']);
    assert.deepEqual(await readdir(root), ['pb_hooks']);
  });
});

test('installer refuses destination junctions before writing outside its target', async () => {
  await workspace(async root => {
    const target = join(root, 'target');
    const outside = join(root, 'outside');
    await mkdir(join(target, 'pb_hooks'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(target, 'pb_hooks/lib'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = install(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destination symlink/);
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(join(target, 'pb_hooks')), ['lib']);
    assert.deepEqual(await readdir(target), ['pb_hooks']);
  });
});

test('an explicitly selected target junction resolves to its real PocketBase directory', async () => {
  await workspace(async root => {
    const actual = join(root, 'actual');
    const target = join(root, 'chosen');
    await mkdir(actual);
    await symlink(actual, target, process.platform === 'win32' ? 'junction' : 'dir');
    const result = install(target);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.ok((await readFile(join(actual, 'pb_hooks/700_replay.pb.js'), 'utf8')).includes('/api/replay/start'));
  });
});
