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

export const BOOTSTRAP_LOCKS = [
  ['package-lock.json', ['npm', 'ci']],
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
  ['yarn.lock', ['yarn', 'install', '--immutable']],
  ['uv.lock', ['uv', 'sync', '--frozen']],
] as const;

export async function bootstrapCommands(
  cwd: string,
  configured: string[][],
): Promise<string[][]> {
  if (configured.length) return configured;
  for (const [file, command] of BOOTSTRAP_LOCKS)
    if (await exists(join(cwd, file))) return [[...command]];
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
