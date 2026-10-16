const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '../../scripts/upload-sourcemaps.mjs');
const KEY = 'k'.repeat(40);
const MAP = JSON.stringify({ version: 3, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' });

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, REPLAY_SOURCEMAP_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function receiver(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://receiver');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-replay-sourcemap-key'], body: Buffer.concat(chunks).toString() };
      requests.push(entry);
      const [status, body] = answer(entry);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}/replay/`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function build(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-replay-sourcemaps-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const dist = {
  'dist/index.html': '<script type="module" src="/assets/index-AAAA1111.js"></script>',
  'dist/assets/index-AAAA1111.js': 'console.log(1)',
  'dist/assets/index-AAAA1111.js.map': MAP,
  'dist/assets/vendor-BBBB2222.mjs.map': MAP,
  'dist/assets/style-CCCC3333.css.map': MAP,
  'dist/server/entry.cjs.map': MAP,
  'dist/node_modules/dep/index.js.map': MAP,
};
const ok = (entry) => [200, { ok: true, segments: 1, sources: 1, replaced: entry.query.path.includes('vendor') }];

test('the CLI uploads every script map under --from with its generated path, version and key', async () => {
  const root = build(dist);
  const server = await receiver(ok);
  try {
    const result = await run(['--endpoint', server.endpoint, '--version', '1.4.0', '--from', path.join(root, 'dist')], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.requests.map((entry) => [entry.method, entry.path, entry.query.appVersion, entry.query.path, entry.key]), [
      ['POST', '/replay/api/replay/sourcemaps', '1.4.0', 'assets/index-AAAA1111.js', KEY],
      ['POST', '/replay/api/replay/sourcemaps', '1.4.0', 'assets/vendor-BBBB2222.mjs', KEY],
      ['POST', '/replay/api/replay/sourcemaps', '1.4.0', 'server/entry.cjs', KEY],
    ]);
    assert.equal(server.requests[0].body, MAP);
    assert.match(result.stdout, /ok +assets\/vendor-BBBB2222\.mjs .*replaced/);
    assert.match(result.stdout, /3 uploaded, 0 failed/);
    assert.ok(fs.existsSync(path.join(root, 'dist/assets/index-AAAA1111.js.map')), 'maps stay without --delete-after');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('--dry-run checks maps without a key or any request, and keeps the files', async () => {
  const root = build({ ...dist, 'dist/assets/broken.js.map': '{not json' });
  const server = await receiver(ok);
  try {
    const result = await run(['--endpoint', server.endpoint, '--version', '1.4.0', '--from', path.join(root, 'dist'), '--dry-run', '--delete-after']);
    assert.equal(result.code, 1);
    assert.equal(server.requests.length, 0);
    assert.match(result.stdout, /Would upload 4 source maps/);
    assert.match(result.stderr, /FAIL +assets\/broken\.js +it is not valid JSON/);
    assert.match(result.stdout, /3 ready, 1 failed\. Nothing was uploaded/);
    assert.ok(fs.existsSync(path.join(root, 'dist/assets/vendor-BBBB2222.mjs.map')));
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('--delete-after removes only the maps the server accepted, and any failure exits non-zero', async () => {
  const root = build(dist);
  const server = await receiver((entry) => entry.query.path.includes('vendor') ? [400, { message: 'Invalid source map: mappings must be sorted by generated column' }] : ok(entry));
  try {
    const result = await run(['--endpoint', server.endpoint, '--version', '1.4.0', '--from', path.join(root, 'dist'), '--delete-after'], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL +assets\/vendor-BBBB2222\.mjs +Invalid source map: mappings must be sorted/);
    assert.match(result.stdout, /2 uploaded, 1 failed/);
    assert.equal(fs.existsSync(path.join(root, 'dist/assets/index-AAAA1111.js.map')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/server/entry.cjs.map')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/assets/vendor-BBBB2222.mjs.map')), true);
    assert.equal(fs.existsSync(path.join(root, 'dist/node_modules/dep/index.js.map')), true);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the CLI refuses symlinks, a missing key, a key argument, bad versions and empty builds', async () => {
  const root = build({ ...dist, 'elsewhere/secret.js.map': MAP });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'dist/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const empty = build({ 'empty/index.html': '' });
  const server = await receiver(ok);
  try {
    const args = ['--endpoint', server.endpoint, '--version', '1.4.0', '--from', path.join(root, 'dist')];
    const linked = await run(args, { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /Refusing symlink/);
    const unkeyed = await run(args);
    assert.equal(unkeyed.code, 1);
    assert.match(unkeyed.stderr, /REPLAY_SOURCEMAP_KEY/);
    const argument = await run([...args, '--key', KEY], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(argument.code, 1);
    assert.match(argument.stderr, /read only from REPLAY_SOURCEMAP_KEY/);
    const version = await run(['--endpoint', server.endpoint, '--version', '1.4 beta', '--from', path.join(root, 'dist')], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(version.code, 1);
    assert.match(version.stderr, /Invalid --version/);
    const nothing = await run(['--endpoint', server.endpoint, '--version', '1.4.0', '--from', path.join(empty, 'empty')], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(nothing.code, 1);
    assert.match(nothing.stderr, /No \.js\.map, \.mjs\.map or \.cjs\.map files/);
    const missing = await run(['--endpoint', server.endpoint, '--from', path.join(root, 'dist')], { REPLAY_SOURCEMAP_KEY: KEY });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Missing --version/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
