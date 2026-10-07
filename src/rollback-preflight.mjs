import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read raw records, including terminal archives; never let an old parser hide them. */
export async function rollbackPreflight(directory) {
  if (!isAbsolute(directory))
    throw new Error('An explicit absolute registry directory is required.');
  const blockers = [];
  let files = 0;
  let entries = 0;
  function nativeRecord(value, depth = 0) {
    if (depth > 64)
      throw new Error('Record nesting exceeds the inspection limit.');
    if (!value || typeof value !== 'object') return false;
    if (value.service === 'native' || Object.hasOwn(value, 'native'))
      return true;
    return Object.values(value).some((child) => nativeRecord(child, depth + 1));
  }
  async function visit(path, depth = 0) {
    if (++entries > 10000 || depth > 64)
      throw new Error('Registry exceeds bounded inspection limits.');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      blockers.push(`${path}: symlink is not an inspectable registry source`);
      return;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.name === 'native' && entry.isDirectory())
          blockers.push(`${child}: retained native operation artifacts`);
        else await visit(child, depth + 1);
      }
    } else if (!info.isFile()) {
      blockers.push(`${path}: non-regular registry source cannot be inspected`);
    } else if (path.endsWith('.json')) {
      if (++files > 10000 || info.size > 8 * 1024 * 1024)
        throw new Error('Registry exceeds bounded inspection limits.');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (nativeRecord(value))
        blockers.push(
          `${path}: native-format record (terminal history also blocks rollback)`,
        );
    }
  }
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error('Registry root must be a real directory.');
    await visit(resolve(directory));
  } catch (error) {
    blockers.push(
      `Inspection incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    safe: blockers.length === 0,
    directory: resolve(directory),
    files,
    blockers,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4 || process.argv[2] !== '--registry') {
    console.error(
      'Usage: node rollback-preflight.mjs --registry /absolute/registry-directory',
    );
    process.exitCode = 2;
  } else {
    const result = await rollbackPreflight(process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.safe) process.exitCode = 1;
  }
}
