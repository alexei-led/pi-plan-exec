import { execFile } from 'node:child_process';
import { lstat, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { progressPath } from './progress.js';
import type { PlanExecRun } from './types.js';

const exec = promisify(execFile);

/** Only executor progress is disposable; shared or tracked files belong to the repository. */
export async function removeRunProgress(
  run: PlanExecRun,
  runs: PlanExecRun[],
): Promise<void> {
  if (!run.progressPath) return;
  let file: Awaited<ReturnType<typeof lstat>>;
  try {
    file = await lstat(run.progressPath);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (resolve(run.progressPath) !== resolve(progressPath(run)))
    throw new Error(
      'Progress path is outside the executor-owned progress location.',
    );
  for (const path of [
    join(run.worktreeCwd, '.ralphex'),
    dirname(run.progressPath),
    run.progressPath,
  ]) {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Progress cleanup refuses symbolic links.');
  }
  if (!file.isFile())
    throw new Error('Progress cleanup expected a regular file.');
  const canonical = await realpath(run.progressPath);
  for (const other of runs) {
    if (other.id === run.id || !other.progressPath) continue;
    try {
      if ((await realpath(other.progressPath)) === canonical) return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  try {
    await exec('git', [
      '-C',
      run.worktreeCwd,
      'ls-files',
      '--error-unmatch',
      '--',
      relative(run.worktreeCwd, run.progressPath),
    ]);
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 1))
      throw error;
  }
  await unlink(run.progressPath);
  await syncDirectory(dirname(run.progressPath));
  for (const path of [
    dirname(run.progressPath),
    join(run.worktreeCwd, '.ralphex'),
  ]) {
    try {
      await rmdir(path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (
        !(
          missing(error) ||
          (error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))
        )
      )
        throw error;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
