#!/usr/bin/env node
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const usage = 'Usage: REPLAY_SOURCEMAP_KEY=... pb-replay-sourcemaps --endpoint https://replay.example.com --version 1.4.0 --from ./dist [--delete-after] [--dry-run]';
const MAX_BYTES = 32 * 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const values = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (name === '--help' || name === '-h') { console.log(usage); process.exit(0); }
  if (name === '--delete-after' || name === '--dry-run') { values[name] = true; continue; }
  if (name === '--key' || name.startsWith('--key=')) fail('The key is read only from REPLAY_SOURCEMAP_KEY, so it stays out of shell history and process lists');
  if (['--endpoint', '--version', '--from'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) { values[name] = args[++i]; continue; }
  fail(`Unknown or incomplete argument: ${name}\n${usage}`);
}
for (const name of ['--endpoint', '--version', '--from']) if (!values[name]) fail(`Missing ${name}\n${usage}`);
const dryRun = values['--dry-run'] === true;
const deleteAfter = values['--delete-after'] === true && !dryRun;

let endpoint;
try { endpoint = new URL(values['--endpoint']); } catch { fail('Invalid --endpoint: use the replay server address, such as https://replay.example.com'); }
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  fail('Invalid --endpoint: use an http or https address without credentials, query or fragment');
}
const base = endpoint.href.replace(/\/+$/, '');
const version = values['--version'];
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
  fail('Invalid --version: use 1 to 64 letters, digits, dots, underscores, plus signs or hyphens, starting with a letter or digit. It must equal the appVersion your app reports');
}
const key = process.env.REPLAY_SOURCEMAP_KEY || '';
if (!dryRun && (key.length < 32 || key.length > 512)) fail('Set REPLAY_SOURCEMAP_KEY to the server\'s source map key (32 to 512 characters)');
if (!dryRun && typeof fetch !== 'function') fail('Node 22 or newer is required');
if (!dryRun && endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  console.warn(`Warning: ${endpoint.host} is reached over plain http, so the key is sent unencrypted`);
}

let root;
try {
  root = await realpath(resolve(values['--from']));
  if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
} catch { fail(`Invalid --from: ${values['--from']} is not a readable directory`); }

// Maps of generated scripts, found recursively. Symlinks are refused rather than followed, and
// installed dependencies are skipped.
async function scan(directory, found) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await scan(path, found);
    } else if (entry.isFile() && /\.[cm]?js\.map$/.test(entry.name)) found.push(path);
  }
  return found;
}

// The server keys a map by its generated file's path in the build, which the app's URLs end with.
function generatedPath(file) {
  const path = relative(root, file).split(sep).join('/').replace(/\.map$/, '');
  if (path.length > 1024 || /[\x00-\x1f\x7f\\?#]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('its path cannot be matched to a URL; rename it without backslashes, ? or #');
  }
  return path;
}

function size(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let files;
try { files = (await scan(root, [])).sort(); } catch (error) { fail(error.message); }
if (!files.length) fail(`No .js.map, .mjs.map or .cjs.map files found in ${root}. Enable source maps in your build, for example build.sourcemap in Vite`);

console.log(`${dryRun ? 'Would upload' : 'Uploading'} ${files.length} source map${files.length === 1 ? '' : 's'} for version ${version} to ${base}`);
let uploaded = 0;
let failed = 0;
const width = Math.min(60, Math.max(...files.map((file) => relative(root, file).length)));
for (const file of files) {
  let path = relative(root, file).split(sep).join('/').replace(/\.map$/, '');
  const started = Date.now();
  try {
    path = generatedPath(file);
    const body = await readFile(file);
    if (body.byteLength > MAX_BYTES) throw new Error(`it is ${size(body.byteLength)}, over the 32 MiB limit`);
    let map;
    try { map = JSON.parse(body.toString('utf8')); } catch { throw new Error('it is not valid JSON'); }
    if (map && map.sections !== undefined) throw new Error('index maps with "sections" are not supported');
    if (!map || map.version !== 3) throw new Error('only version 3 source maps are supported');
    if (dryRun) {
      console.log(`  check ${path.padEnd(width)}  ${size(body.byteLength)}`);
      uploaded++;
      continue;
    }
    const response = await fetch(`${base}/api/replay/sourcemaps?appVersion=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-replay-sourcemap-key': key }, body, signal: AbortSignal.timeout(300000),
    });
    let result = {};
    try { result = await response.json(); } catch { /* The status is reported instead. */ }
    if (!response.ok) throw new Error(result.message || `the server answered ${response.status}`);
    let note = `${size(body.byteLength)}, ${result.segments} segments, ${result.sources} sources, ${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (result.replaced) note += ', replaced';
    if (deleteAfter) {
      await unlink(file);
      note += ', map deleted';
    }
    console.log(`  ok    ${path.padEnd(width)}  ${note}`);
    uploaded++;
  } catch (error) {
    const cause = error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    console.error(`  FAIL  ${path.padEnd(width)}  ${error.message}${cause}`);
    failed++;
  }
}
console.log(dryRun ? `${uploaded} ready, ${failed} failed. Nothing was uploaded` : `${uploaded} uploaded, ${failed} failed`);
if (failed) process.exitCode = 1;
