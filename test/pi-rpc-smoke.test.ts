import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { onTestFinished, test } from 'vitest';

test('real Pi RPC registers exec and renders isolated status without model dispatch', {
  timeout: 20_000,
}, async (_t) => {
  const directory = resolve('.pi/autonomous-smoke-tests');
  await mkdir(directory, { recursive: true });
  const sandbox = await mkdtemp(join(directory, 'run-'));
  onTestFinished(() => rm(sandbox, { recursive: true, force: true }));
  const preload = join(sandbox, 'isolate.mjs');
  await writeFile(
    preload,
    `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.homedir = () => ${JSON.stringify(sandbox)};
syncBuiltinESMExports();
`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      '--mode',
      'rpc',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '-e',
      resolve('src/index.ts'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: join(sandbox, '.pi/agent') },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  onTestFinished(() => {
    child.kill('SIGKILL');
  });
  let pending = '';
  let errors = '';
  let commandsRegistered = false;
  let statusRendered = false;
  let modelStarted = false;
  child.stdout.on('data', (data: Buffer) => {
    pending += data.toString();
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      if (value.type === 'agent_start') modelStarted = true;
      if (
        value.type === 'response' &&
        value.id === 'commands' &&
        isRecord(value.data) &&
        Array.isArray(value.data.commands)
      ) {
        const commands = value.data.commands;
        commandsRegistered = ['exec', 'goal'].every((name) =>
          commands.some(
            (command: unknown) => isRecord(command) && command.name === name,
          ),
        );
        child.stdin.write(
          `${JSON.stringify({ id: 'status', type: 'prompt', message: '/exec status' })}\n`,
        );
      }
      if (
        value.type === 'extension_ui_request' &&
        typeof value.message === 'string' &&
        /No .*runs/i.test(value.message)
      )
        statusRendered = true;
      if (commandsRegistered && statusRendered) child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', () => done());
  });
  child.stdin.write(
    `${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`,
  );
  await closed;
  assert.equal(commandsRegistered, true, errors.slice(-2_000));
  assert.equal(statusRendered, true, errors.slice(-2_000));
  assert.equal(modelStarted, false);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
