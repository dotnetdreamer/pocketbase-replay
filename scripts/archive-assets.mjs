#!/usr/bin/env node
import { readdir, readFile, mkdir, copyFile, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep, extname } from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
for (const name of ['--from', '--target', '--version']) {
  if (!args.includes(name) || !arg(name) || arg(name).startsWith('--')) {
    throw new Error('Usage: pb-replay-assets --from dist --target backend --version 1.0.0');
  }
}
const version = arg('--version');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version)) throw new Error('Invalid version');
const source = await realpath(resolve(arg('--from')));
await mkdir(resolve(arg('--target')), { recursive: true });
const target = await realpath(resolve(arg('--target')));
const destinationRoot = join(target, 'pb_public', 'replay-assets', version);
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.woff', '.woff2', '.ttf', '.otf']);
const pending = [];
async function checkDestination(destination) {
  const suffix = relative(target, destination);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) throw new Error('Path escapes target');
  let current = target;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Refusing destination symlink: ${current}`);
    const resolved = relative(target, await realpath(current));
    if (isAbsolute(resolved) || resolved === '..' || resolved.startsWith('..' + sep)) throw new Error('Path escapes target');
    if (current !== destination && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
  }
}
async function scan(directory) {
  let entries;
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing source symlink: ${directory}`);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${path}`);
    if (entry.isDirectory()) { await scan(path); continue; }
    if (!extensions.has(extname(path).toLowerCase())) continue;
    const content = await readFile(path);
    if (content.byteLength > 10 * 1024 * 1024) throw new Error(`Asset exceeds 10 MiB: ${path}`);
    const destination = join(destinationRoot, relative(source, path));
    await checkDestination(destination);
    let existing;
    try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.equals(content)) throw new Error(`Version already contains a different asset: ${destination}`);
    if (!existing) pending.push([path, destination]);
  }
}
for (const directory of ['assets', 'fonts', 'icons']) await scan(join(source, directory));
for (const [path, destination] of pending) {
  await checkDestination(destination);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await checkDestination(destination);
  await copyFile(path, destination, constants.COPYFILE_EXCL);
}
console.log(`Archived ${pending.length} public image/font assets into ${destinationRoot}`);
