import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fixtureGitEnvironment } from './autonomous-git-environment.mjs';

export default function scriptedSessions() {
  return {
    async create(launch) {
      const listeners = new Set();
      const messages = [];
      const tools = new Map();
      if (launch.runtime.structuredOutput) {
        for (const hook of launch.hooks)
          hook.factory({
            on() {},
            registerTool(tool) {
              tools.set(tool.name, tool);
            },
            events: {
              on() {
                return () => {};
              },
              emit() {},
            },
            getAllTools() {
              return [];
            },
            getActiveTools() {
              return [];
            },
            setActiveTools() {},
          });
      }
      const sessionId = randomUUID();
      const sessionFile =
        launch.storage.kind === 'file' ? launch.storage.sessionFile : undefined;
      if (sessionFile) {
        mkdirSync(dirname(sessionFile), { recursive: true });
        writeFileSync(sessionFile, '');
      }
      const emit = (event) => {
        if (event.type === 'message_end') messages.push(event.message);
        for (const listener of listeners) listener(event);
      };
      return {
        sessionId,
        sessionFile,
        modelId: 'scripted/smoke',
        messages,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          const agent = launch.runtime.agent;
          assert.ok(
            agent === 'worker' ||
              agent === 'reviewer' ||
              agent === 'plan-exec-reviewer',
            `Unexpected smoke agent: ${agent}`,
          );
          let output = 'NO_FINDINGS';
          if (
            agent === 'worker' &&
            process.env.PI_NATIVE_CONTROLLER_SMOKE === 'fix' &&
            readFileSync(join(launch.cwd, 'plan.md'), 'utf8').includes(
              '- [x] Deliver fixture',
            )
          ) {
            writeFileSync(
              join(launch.cwd, 'metadata.txt'),
              'reviewed fixture metadata\n',
            );
            execFileSync('git', ['add', 'metadata.txt'], {
              cwd: launch.cwd,
              env: fixtureGitEnvironment(),
            });
            execFileSync(
              'git',
              ['commit', '-m', 'Fix reviewer metadata finding'],
              { cwd: launch.cwd, env: fixtureGitEnvironment() },
            );
            output = 'Review finding fixed and committed.';
          } else if (agent === 'worker') {
            const planPath = join(launch.cwd, 'plan.md');
            assert.match(
              readFileSync(planPath, 'utf8'),
              /- \[ \] Deliver fixture/,
            );
            writeFileSync(
              planPath,
              readFileSync(planPath, 'utf8').replace(
                '- [ ] Deliver fixture',
                '- [x] Deliver fixture',
              ),
            );
            writeFileSync(
              join(launch.cwd, 'result.txt'),
              'autonomous runtime smoke\n',
            );
            for (const args of [
              ['add', 'plan.md', 'result.txt'],
              ['commit', '-m', 'Implement smoke fixture'],
            ])
              execFileSync('git', args, {
                cwd: launch.cwd,
                env: fixtureGitEnvironment(),
                stdio: 'pipe',
              });
            output =
              process.env.PI_NATIVE_CONTROLLER_SMOKE === 'goal'
                ? '<<<RALPHEX:GOAL_DONE>>>'
                : 'Task completed and committed.';
          } else {
            assert.equal(
              readFileSync(join(launch.cwd, 'result.txt'), 'utf8'),
              'autonomous runtime smoke\n',
            );
            execFileSync(process.execPath, ['check.mjs'], {
              cwd: launch.cwd,
              stdio: 'pipe',
            });
          }
          if (agent !== 'worker' && process.env.PI_NATIVE_CONTROLLER_SMOKE)
            output = JSON.stringify({
              schemaVersion: 1,
              reviewedCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: launch.cwd,
                encoding: 'utf8',
              }).trim(),
              findings:
                process.env.PI_NATIVE_CONTROLLER_SMOKE === 'fix' &&
                !existsSync(join(launch.cwd, 'metadata.txt'))
                  ? [
                      {
                        severity: 'MAJOR',
                        summary: 'Required fixture metadata is missing',
                        evidence:
                          'metadata.txt does not exist in the reviewed checkout.',
                        suggestion:
                          'Add metadata.txt with reviewed fixture metadata.',
                      },
                    ]
                  : [],
            });
          appendFileSync(
            process.env.PI_AUTONOMOUS_SMOKE_CALLS,
            `${JSON.stringify({ agent, cwd: launch.cwd, pid: process.pid, executionLifetime: launch.runtime?.executionLifetime ?? null, output })}\n`,
          );
          emit({ type: 'agent_start' });
          if (launch.runtime.structuredOutput) {
            const tool = tools.get('structured_output');
            assert.ok(
              tool,
              'Real native structured output tool must be installed',
            );
            const args = { value: JSON.parse(output) };
            emit({
              type: 'tool_execution_start',
              toolName: 'structured_output',
              toolCallId: 'fixture-structured',
              args,
            });
            const result = await tool.execute('fixture-structured', args);
            emit({
              type: 'tool_execution_end',
              toolName: 'structured_output',
              toolCallId: 'fixture-structured',
              result,
              isError: false,
            });
          }
          emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: output }],
              model: 'scripted/smoke',
              stopReason: 'stop',
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          });
          emit({
            type: 'agent_end',
            messages: [...messages],
            willRetry: false,
          });
          emit({ type: 'agent_settled' });
        },
        async steer() {
          throw new Error('Smoke session does not accept steering');
        },
        async followUp() {
          throw new Error('Smoke session does not accept follow-ups');
        },
        async abort() {},
        async dispose() {},
        hasQueuedMessages() {
          return false;
        },
      };
    },
    async dispose() {},
  };
}
