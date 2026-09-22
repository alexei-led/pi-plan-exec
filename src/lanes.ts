import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCommand } from './git.js';
import {
  type LocalOperationOptions,
  runLocalOperation,
} from './local-operation.js';

export async function gitValue(
  command: RunCommand,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await command('git', args, cwd);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrapCommands(
  cwd: string,
  configured: string[][],
): Promise<string[][]> {
  if (configured.length) return configured;
  if (await exists(join(cwd, 'package-lock.json'))) return [['npm', 'ci']];
  if (await exists(join(cwd, 'pnpm-lock.yaml')))
    return [['pnpm', 'install', '--frozen-lockfile']];
  if (await exists(join(cwd, 'yarn.lock')))
    return [['yarn', 'install', '--immutable']];
  if (await exists(join(cwd, 'uv.lock'))) return [['uv', 'sync', '--frozen']];
  return [];
}

export async function requiredChecks(
  cwd: string,
  configured: string[][],
): Promise<string[][]> {
  if (configured.length) return configured;
  if (await exists(join(cwd, 'Makefile')))
    return ['fmt', 'build', 'test', 'lint'].map((name) => ['make', name]);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('scripts' in data) ||
    !data.scripts ||
    typeof data.scripts !== 'object'
  )
    return [];
  const scripts = data.scripts;
  return ['check', 'build', 'test', 'lint', 'pack:dry']
    .filter((name) => name in scripts)
    .map((name) => ['npm', 'run', name]);
}

export async function runCommands(
  cwd: string,
  commands: string[][],
  options: LocalOperationOptions,
): Promise<void> {
  return runLocalOperation(cwd, commands, options);
}
