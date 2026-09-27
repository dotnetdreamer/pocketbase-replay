#!/usr/bin/env node
import { readdir, readFile, mkdir, copyFile, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
if (targetIndex < 0 || !args[targetIndex + 1]) throw new Error('Usage: node scripts/install.mjs --target <PocketBase directory> [--dedicated]');
const dedicated = args.includes('--dedicated');
const requestedTarget = resolve(args[targetIndex + 1]);
await mkdir(requestedTarget, { recursive: true });
const target = await realpath(requestedTarget);
const source = fileURLToPath(new URL('../server/', import.meta.url));
const pending = [];
async function checkDestination(destination) {
  const suffix = relative(target, destination);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) throw new Error(`Path escapes target: ${destination}`);
  let current = target;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Refusing destination symlink: ${current}`);
    const resolved = relative(target, await realpath(current));
    if (isAbsolute(resolved) || resolved === '..' || resolved.startsWith('..' + sep)) throw new Error(`Path escapes target: ${current}`);
    if (current !== destination && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
  }
}

async function scan(directory, into) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) { await scan(path, join(into, entry.name)); continue; }
    const destination = join(into, entry.name);
    await checkDestination(destination);
    let existing;
    try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.equals(await readFile(path))) throw new Error(`Existing file differs: ${destination}`);
    if (!existing) pending.push([path, destination]);
  }
}
await scan(join(source, 'pb_hooks'), join(target, 'pb_hooks'));
await scan(join(source, 'pb_migrations'), join(target, 'pb_migrations'));
if (dedicated) await scan(join(source, 'pb_migrations_dedicated'), join(target, 'pb_migrations'));
for (const [path, destination] of pending) {
  await checkDestination(destination);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await checkDestination(destination);
  await copyFile(path, destination, constants.COPYFILE_EXCL);
}
console.log(`Installed ${pending.length} replay files into ${target}`);
